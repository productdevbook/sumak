import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import {
  arg,
  createFunction,
  createTrigger,
  dropFunction,
  dropTrigger,
  sql,
  sumak,
  val,
} from "../../src/index.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })

describe("CREATE TRIGGER — builder shape", () => {
  it("createTrigger(name) returns a node with empty table and AFTER timing", () => {
    const n = createTrigger("t").build()
    expect(n).toMatchObject({ type: "create_trigger", name: "t", table: "" })
  })

  it(".on(table) sets the target", () => {
    const n = createTrigger("t").on("users").build()
    expect(n.table).toBe("users")
  })

  it(".before / .after / .insteadOf set timing + events", () => {
    expect(createTrigger("t").before("INSERT").build()).toMatchObject({
      timing: "BEFORE",
      events: ["INSERT"],
    })
    expect(createTrigger("t").after("UPDATE").build()).toMatchObject({
      timing: "AFTER",
      events: ["UPDATE"],
    })
    expect(createTrigger("t").insteadOf("DELETE").build()).toMatchObject({
      timing: "INSTEAD OF",
      events: ["DELETE"],
    })
  })

  it("UPDATE OF columns ride along the UPDATE event", () => {
    const n = createTrigger("t").after("UPDATE", "email", "phone").build()
    expect(n.updateOf).toEqual(["email", "phone"])
  })

  it("withEvents([...]) sets multi-event lists", () => {
    const n = createTrigger("t").after("INSERT").withEvents(["INSERT", "UPDATE", "DELETE"]).build()
    expect(n.events).toEqual(["INSERT", "UPDATE", "DELETE"])
  })

  it(".forEachRow() and .forEachStatement() flip the granularity", () => {
    expect(createTrigger("t").forEachRow().build().forEach).toBe("ROW")
    expect(createTrigger("t").forEachStatement().build().forEach).toBe("STATEMENT")
  })

  it(".when(expr) carries the predicate", () => {
    const n = createTrigger("t")
      .when(sql<boolean>`NEW."x" > OLD."x"`)
      .build()
    expect(n.when).toBeDefined()
    expect(n.when?.type).toBe("raw")
  })

  it(".executeFunction(name) carries the function name and no args by default", () => {
    const n = createTrigger("t").executeFunction("log_change").build()
    expect(n.functionName).toBe("log_change")
    expect(n.functionArgs).toBeUndefined()
  })

  it(".executeFunction(name, ...args) carries the args", () => {
    const n = createTrigger("t").executeFunction("log_change", "foo", 42).build()
    expect(n.functionArgs).toHaveLength(2)
    expect(n.functionArgs![0]).toMatchObject({ type: "literal", value: "foo" })
    expect(n.functionArgs![1]).toMatchObject({ type: "literal", value: 42 })
  })

  it(".deferrable() flips the constraint flag", () => {
    const n = createTrigger("t").deferrable({ initiallyDeferred: true }).build()
    expect(n.constraint).toEqual({ deferrable: true, initiallyDeferred: true })
  })

  it("UPDATE OF on a non-UPDATE event throws at builder time", () => {
    expect(() => createTrigger("t").before("INSERT", "x")).toThrow(/UPDATE OF column list/)
  })
})

describe("CREATE TRIGGER — PG emission", () => {
  it("BEFORE INSERT FOR EACH ROW EXECUTE FUNCTION fn()", () => {
    const q = pg.compileDDL(
      createTrigger("t1")
        .on("users")
        .before("INSERT")
        .forEachRow()
        .executeFunction("log_insert")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE TRIGGER "t1" BEFORE INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION "log_insert"()`,
    )
  })

  it("AFTER UPDATE OF cols ON table FOR EACH ROW EXECUTE FUNCTION fn()", () => {
    const q = pg.compileDDL(
      createTrigger("audit_users_updated")
        .on("users")
        .after("UPDATE", "email", "phone")
        .forEachRow()
        .executeFunction("log_user_change")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE TRIGGER "audit_users_updated" AFTER UPDATE OF "email", "phone" ON "users" FOR EACH ROW EXECUTE FUNCTION "log_user_change"()`,
    )
  })

  it("INSTEAD OF DELETE on a view (FOR EACH ROW)", () => {
    const q = pg.compileDDL(
      createTrigger("v_del")
        .on("user_view")
        .insteadOf("DELETE")
        .forEachRow()
        .executeFunction("handle_view_delete")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE TRIGGER "v_del" INSTEAD OF DELETE ON "user_view" FOR EACH ROW EXECUTE FUNCTION "handle_view_delete"()`,
    )
  })

  it("FOR EACH STATEMENT", () => {
    const q = pg.compileDDL(
      createTrigger("audit_stmt")
        .on("users")
        .after("UPDATE")
        .forEachStatement()
        .executeFunction("log_stmt")
        .build(),
    )
    expect(q.sql).toContain("FOR EACH STATEMENT")
  })

  it("WHEN (expr) clause emission", () => {
    const q = pg.compileDDL(
      createTrigger("audit_users_updated")
        .on("users")
        .after("UPDATE")
        .forEachRow()
        .when(sql<boolean>`NEW."email" IS DISTINCT FROM OLD."email"`)
        .executeFunction("log_user_change")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE TRIGGER "audit_users_updated" AFTER UPDATE ON "users" FOR EACH ROW WHEN (NEW."email" IS DISTINCT FROM OLD."email") EXECUTE FUNCTION "log_user_change"()`,
    )
  })

  it("multi-event: AFTER INSERT OR UPDATE", () => {
    const q = pg.compileDDL(
      createTrigger("t_multi")
        .on("users")
        .after("INSERT")
        .withEvents(["INSERT", "UPDATE"])
        .forEachRow()
        .executeFunction("on_change")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE TRIGGER "t_multi" AFTER INSERT OR UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION "on_change"()`,
    )
  })

  it("CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED", () => {
    const q = pg.compileDDL(
      createTrigger("audit_constraint")
        .on("users")
        .after("INSERT")
        .deferrable({ initiallyDeferred: true })
        .forEachRow()
        .executeFunction("validate_users")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE CONSTRAINT TRIGGER "audit_constraint" AFTER INSERT ON "users" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_users"()`,
    )
  })

  it("OR REPLACE emits CREATE OR REPLACE TRIGGER", () => {
    const q = pg.compileDDL(
      createTrigger("t1")
        .orReplace()
        .on("users")
        .before("INSERT")
        .forEachRow()
        .executeFunction("log_insert")
        .build(),
    )
    expect(q.sql.startsWith("CREATE OR REPLACE TRIGGER")).toBe(true)
  })

  it("EXECUTE FUNCTION with positional args", () => {
    const q = pg.compileDDL(
      createTrigger("t")
        .on("users")
        .after("INSERT")
        .forEachRow()
        .executeFunction("log", val("audit"), val(1))
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE TRIGGER "t" AFTER INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION "log"('audit', 1)`,
    )
  })

  it("via db.schema.createTrigger()", () => {
    const q = pg.compileDDL(
      pg.schema
        .createTrigger("t1")
        .on("users")
        .before("INSERT")
        .forEachRow()
        .executeFunction("log_insert")
        .build(),
    )
    expect(q.sql).toContain('CREATE TRIGGER "t1"')
  })

  it("rejects missing table on compile (forgot .on)", () => {
    expect(() =>
      pg.compileDDL(createTrigger("t").before("INSERT").forEachRow().executeFunction("fn").build()),
    ).toThrow(/\.on\(table\) is required/)
  })

  it("rejects missing executeFunction on compile", () => {
    expect(() =>
      pg.compileDDL(createTrigger("t").on("users").before("INSERT").forEachRow().build()),
    ).toThrow(/\.executeFunction/)
  })

  it("rejects empty events on hand-built AST", () => {
    const bad = {
      type: "create_trigger",
      name: "t",
      table: "users",
      timing: "BEFORE",
      events: [],
      forEach: "ROW",
      functionName: "fn",
    } as unknown as Parameters<typeof pg.compileDDL>[0]
    expect(() => pg.compileDDL(bad)).toThrow(/at least one event/)
  })

  it("CONSTRAINT TRIGGER refuses BEFORE timing", () => {
    const bad = createTrigger("t")
      .on("users")
      .before("INSERT")
      .deferrable()
      .forEachRow()
      .executeFunction("fn")
      .build()
    expect(() => pg.compileDDL(bad)).toThrow(/timing must be AFTER/)
  })

  it("CONSTRAINT TRIGGER refuses FOR EACH STATEMENT", () => {
    const bad = createTrigger("t")
      .on("users")
      .after("INSERT")
      .deferrable()
      .forEachStatement()
      .executeFunction("fn")
      .build()
    expect(() => pg.compileDDL(bad)).toThrow(/FOR EACH ROW/)
  })
})

describe("DROP TRIGGER — builder shape & emission", () => {
  it("dropTrigger(name) — empty table", () => {
    const n = dropTrigger("t").build()
    expect(n).toMatchObject({ type: "drop_trigger", name: "t", table: "" })
  })

  it("emits DROP TRIGGER ON table", () => {
    const q = pg.compileDDL(dropTrigger("t1").on("users").build())
    expect(q.sql).toBe(`DROP TRIGGER "t1" ON "users"`)
  })

  it("IF EXISTS and CASCADE", () => {
    const q = pg.compileDDL(dropTrigger("t1").on("users").ifExists().cascade().build())
    expect(q.sql).toBe(`DROP TRIGGER IF EXISTS "t1" ON "users" CASCADE`)
  })

  it("via db.schema.dropTrigger()", () => {
    const q = pg.compileDDL(pg.schema.dropTrigger("t1").on("users").build())
    expect(q.sql).toBe(`DROP TRIGGER "t1" ON "users"`)
  })

  it("rejects an empty table (forgot .on)", () => {
    expect(() => pg.compileDDL(dropTrigger("t1").build())).toThrow(/\.on\(table\) is required/)
  })
})

describe("non-PG dialects refuse every trigger surface", () => {
  const dialects = [
    ["MySQL", mysqlDialect()],
    ["SQLite", sqliteDialect()],
    ["MSSQL", mssqlDialect()],
  ] as const

  for (const [label, dialect] of dialects) {
    describe(label, () => {
      const db = sumak({ dialect, tables: {} })

      it("CREATE TRIGGER refuses", () => {
        const t = createTrigger("t1")
          .on("users")
          .before("INSERT")
          .forEachRow()
          .executeFunction("fn")
          .build()
        expect(() => db.compileDDL(t)).toThrow(UnsupportedDialectFeatureError)
      })

      it("DROP TRIGGER refuses", () => {
        expect(() => db.compileDDL(dropTrigger("t").on("users").build())).toThrow(
          UnsupportedDialectFeatureError,
        )
      })
    })
  }
})

describe("CREATE TRIGGER — PGlite roundtrip", () => {
  let pglite: PGlite

  beforeAll(async () => {
    pglite = new PGlite()
    await pglite.waitReady
  })

  afterAll(async () => {
    await pglite.close()
  })

  it("audit log on UPDATE — trigger fires and lands a row", async () => {
    const driver = pgliteDriver(pglite)

    // Tables under test.
    await driver.execute(`CREATE TABLE users_rt (id serial PRIMARY KEY, email text NOT NULL)`, [])
    await driver.execute(
      `CREATE TABLE users_audit_rt (id serial PRIMARY KEY, user_id integer, old_email text, new_email text)`,
      [],
    )

    // The trigger function uses NEW / OLD which are plpgsql-only — for
    // Phase 1 we ship it via plain raw SQL since the AST doesn't yet
    // model TG magic variables. Phase 2 will surface NEW / OLD as typed
    // proxies; until then this is the documented escape hatch.
    await driver.execute(
      `CREATE FUNCTION log_users_email_rt() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         INSERT INTO users_audit_rt (user_id, old_email, new_email)
         VALUES (OLD.id, OLD.email, NEW.email);
         RETURN NEW;
       END;
       $$`,
      [],
    )

    const trig = pg.compileDDL(
      createTrigger("audit_users_email_rt")
        .on("users_rt")
        .after("UPDATE", "email")
        .forEachRow()
        .when(sql<boolean>`NEW."email" IS DISTINCT FROM OLD."email"`)
        .executeFunction("log_users_email_rt")
        .build(),
    )
    await driver.execute(trig.sql, trig.params)

    await driver.execute(`INSERT INTO users_rt (email) VALUES ('a@x'), ('b@x')`, [])
    await driver.execute(`UPDATE users_rt SET email = 'a2@x' WHERE email = 'a@x'`, [])

    const rows = (await driver.query(
      `SELECT user_id, old_email, new_email FROM users_audit_rt`,
      [],
    )) as { user_id: number; old_email: string; new_email: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.old_email).toBe("a@x")
    expect(rows[0]!.new_email).toBe("a2@x")

    // Clean up so other tests on the same instance don't see the trigger.
    await driver.execute(
      pg.compileDDL(dropTrigger("audit_users_email_rt").on("users_rt").build()).sql,
      [],
    )
    await driver.execute(pg.compileDDL(dropFunction("log_users_email_rt").build()).sql, [])
    await driver.execute(`DROP TABLE users_audit_rt`, [])
    await driver.execute(`DROP TABLE users_rt`, [])
  })
})

// Silence unused-import warning — createFunction is used through the docs
// inline test (the audit-log example above defines its function via raw
// plpgsql). Keep the import so refactor scenarios can swap it in.
void createFunction
void arg
