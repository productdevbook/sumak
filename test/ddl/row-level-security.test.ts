import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { alterTable } from "../../src/builder/ddl/alter-table.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { createPolicy, dropPolicy } from "../../src/index.ts"
import { sql } from "../../src/index.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })

describe("CREATE POLICY — builder shape", () => {
  it("createPolicy(name) returns a node with an empty table", () => {
    const node = createPolicy("p1").build()
    expect(node).toMatchObject({ type: "create_policy", name: "p1", table: "" })
  })

  it(".on(table) sets the target", () => {
    const node = createPolicy("p1").on("orders").build()
    expect(node.table).toBe("orders")
  })

  it(".on(table, schema) sets schema too", () => {
    const node = createPolicy("p1").on("orders", "shop").build()
    expect(node).toMatchObject({ table: "orders", schema: "shop" })
  })

  it(".permissive() and .restrictive() are mutually-exclusive flips", () => {
    const a = createPolicy("p").on("t").permissive().build()
    expect(a).toMatchObject({ permissive: true, restrictive: false })
    const b = createPolicy("p").on("t").restrictive().build()
    expect(b).toMatchObject({ permissive: false, restrictive: true })
  })

  it(".for(...) sets the command", () => {
    const node = createPolicy("p").on("t").for("SELECT").build()
    expect(node.forCommand).toBe("SELECT")
  })

  it(".to(...roles) carries the role list", () => {
    const node = createPolicy("p").on("t").to("alice", "PUBLIC").build()
    expect(node.roles).toEqual(["alice", "PUBLIC"])
  })

  it(".using(sql) accepts an Expression<boolean>", () => {
    const node = createPolicy("p")
      .on("orders")
      .using(sql<boolean>`tenant_id = 1`)
      .build()
    expect(node.using).toBeDefined()
    expect(node.using?.type).toBeTypeOf("string")
  })

  it(".withCheck(sql) accepts an Expression<boolean>", () => {
    const node = createPolicy("p")
      .on("orders")
      .withCheck(sql<boolean>`tenant_id = 1`)
      .build()
    expect(node.withCheck).toBeDefined()
  })

  it(".to() replaces a previous .to() call (idempotent chains)", () => {
    const node = createPolicy("p").on("t").to("alice").to("bob", "carol").build()
    expect(node.roles).toEqual(["bob", "carol"])
  })

  it("builder.build() returns an independent copy of the roles array", () => {
    const b = createPolicy("p").on("t").to("alice", "bob")
    const node = b.build()
    node.roles!.push("eve")
    const fresh = b.build()
    expect(fresh.roles).toEqual(["alice", "bob"])
  })
})

describe("CREATE POLICY — PG emission", () => {
  it("bare form — name + on(table)", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders"')
  })

  it("schema-qualified table", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders", "shop").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "shop"."orders"')
  })

  it("AS PERMISSIVE explicit", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").permissive().build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" AS PERMISSIVE')
  })

  it("AS RESTRICTIVE", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").restrictive().build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" AS RESTRICTIVE')
  })

  it("FOR SELECT", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").for("SELECT").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" FOR SELECT')
  })

  it("FOR ALL", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").for("ALL").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" FOR ALL')
  })

  it("FOR INSERT", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").for("INSERT").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" FOR INSERT')
  })

  it("FOR UPDATE", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").for("UPDATE").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" FOR UPDATE')
  })

  it("FOR DELETE", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").for("DELETE").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" FOR DELETE')
  })

  it("TO single role — quoted as identifier", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").to("alice").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" TO "alice"')
  })

  it("TO multiple roles", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").to("alice", "bob").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" TO "alice", "bob"')
  })

  it("TO PUBLIC — reserved keyword, no quoting", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").to("PUBLIC").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" TO PUBLIC')
  })

  it("TO public (lowercase) — recognised as the reserved keyword", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").to("public").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" TO PUBLIC')
  })

  it("TO CURRENT_USER / SESSION_USER — reserved keywords pass through", () => {
    const a = pg.compileDDL(createPolicy("p1").on("orders").to("CURRENT_USER").build())
    expect(a.sql).toBe('CREATE POLICY "p1" ON "orders" TO CURRENT_USER')
    const b = pg.compileDDL(createPolicy("p1").on("orders").to("SESSION_USER").build())
    expect(b.sql).toBe('CREATE POLICY "p1" ON "orders" TO SESSION_USER')
  })

  it("TO mixed reserved + role names", () => {
    const q = pg.compileDDL(createPolicy("p1").on("orders").to("alice", "PUBLIC").build())
    expect(q.sql).toBe('CREATE POLICY "p1" ON "orders" TO "alice", PUBLIC')
  })

  it("USING predicate (sql template)", () => {
    const q = pg.compileDDL(
      createPolicy("p1")
        .on("orders")
        .using(sql<boolean>`tenant_id = current_setting('app.tenant_id')::int`)
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE POLICY "p1" ON "orders" USING (tenant_id = current_setting('app.tenant_id')::int)`,
    )
  })

  it("WITH CHECK predicate (sql template)", () => {
    const q = pg.compileDDL(
      createPolicy("p1")
        .on("orders")
        .withCheck(sql<boolean>`tenant_id = current_setting('app.tenant_id')::int`)
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE POLICY "p1" ON "orders" WITH CHECK (tenant_id = current_setting('app.tenant_id')::int)`,
    )
  })

  it("full surface — AS RESTRICTIVE FOR ALL TO role USING WITH CHECK", () => {
    const q = pg.compileDDL(
      createPolicy("tenant_isolation")
        .on("orders")
        .restrictive()
        .for("ALL")
        .to("app_user")
        .using(sql<boolean>`tenant_id = current_setting('app.tenant_id')::int`)
        .withCheck(sql<boolean>`tenant_id = current_setting('app.tenant_id')::int`)
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE POLICY "tenant_isolation" ON "orders" AS RESTRICTIVE FOR ALL TO "app_user" ` +
        `USING (tenant_id = current_setting('app.tenant_id')::int) ` +
        `WITH CHECK (tenant_id = current_setting('app.tenant_id')::int)`,
    )
  })

  it("via db.schema.createPolicy()", () => {
    const q = pg.compileDDL(
      pg.schema
        .createPolicy("p1")
        .on("orders")
        .for("SELECT")
        .using(sql<boolean>`tenant_id = 1`)
        .build(),
    )
    expect(q.sql).toBe(`CREATE POLICY "p1" ON "orders" FOR SELECT USING (tenant_id = 1)`)
  })

  it("rejects permissive + restrictive both set", () => {
    const bad = createPolicy("p1").on("orders").permissive().build()
    bad.restrictive = true
    expect(() => pg.compileDDL(bad)).toThrow(/mutually exclusive/)
  })

  it("rejects an empty table (forgot .on)", () => {
    expect(() => pg.compileDDL(createPolicy("p1").build())).toThrow(/requires a target table/)
  })

  it("rejects an unknown forCommand on hand-built AST", () => {
    const bad = {
      type: "create_policy",
      name: "p1",
      table: "orders",
      forCommand: "TRUNCATE",
    } as unknown as Parameters<typeof pg.compileDDL>[0]
    expect(() => pg.compileDDL(bad)).toThrow(/ALL \/ SELECT \/ INSERT \/ UPDATE \/ DELETE/)
  })
})

describe("DROP POLICY — builder shape", () => {
  it("dropPolicy(name) — empty table", () => {
    const node = dropPolicy("p1").build()
    expect(node).toMatchObject({ type: "drop_policy", name: "p1", table: "" })
  })

  it(".on(table)", () => {
    const node = dropPolicy("p1").on("orders").build()
    expect(node.table).toBe("orders")
  })

  it(".ifExists()", () => {
    const node = dropPolicy("p1").on("orders").ifExists().build()
    expect(node.ifExists).toBe(true)
  })

  it(".cascade()", () => {
    const node = dropPolicy("p1").on("orders").cascade().build()
    expect(node.cascade).toBe(true)
  })
})

describe("DROP POLICY — PG emission", () => {
  it("bare drop", () => {
    const q = pg.compileDDL(dropPolicy("p1").on("orders").build())
    expect(q.sql).toBe('DROP POLICY "p1" ON "orders"')
  })

  it("IF EXISTS", () => {
    const q = pg.compileDDL(dropPolicy("p1").on("orders").ifExists().build())
    expect(q.sql).toBe('DROP POLICY IF EXISTS "p1" ON "orders"')
  })

  it("CASCADE", () => {
    const q = pg.compileDDL(dropPolicy("p1").on("orders").cascade().build())
    expect(q.sql).toBe('DROP POLICY "p1" ON "orders" CASCADE')
  })

  it("schema-qualified", () => {
    const q = pg.compileDDL(dropPolicy("p1").on("orders", "shop").build())
    expect(q.sql).toBe('DROP POLICY "p1" ON "shop"."orders"')
  })

  it("via db.schema.dropPolicy()", () => {
    const q = pg.compileDDL(pg.schema.dropPolicy("p1").on("orders").ifExists().build())
    expect(q.sql).toBe('DROP POLICY IF EXISTS "p1" ON "orders"')
  })

  it("rejects an empty table (forgot .on)", () => {
    expect(() => pg.compileDDL(dropPolicy("p1").build())).toThrow(/requires a target table/)
  })
})

describe("ALTER TABLE … {ENABLE,DISABLE,FORCE,NO FORCE} ROW LEVEL SECURITY — PG emission", () => {
  it("ENABLE", () => {
    const q = pg.compileDDL(alterTable("orders").enableRowLevelSecurity().build())
    expect(q.sql).toBe('ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY')
  })

  it("DISABLE", () => {
    const q = pg.compileDDL(alterTable("orders").disableRowLevelSecurity().build())
    expect(q.sql).toBe('ALTER TABLE "orders" DISABLE ROW LEVEL SECURITY')
  })

  it("FORCE", () => {
    const q = pg.compileDDL(alterTable("orders").forceRowLevelSecurity().build())
    expect(q.sql).toBe('ALTER TABLE "orders" FORCE ROW LEVEL SECURITY')
  })

  it("NO FORCE", () => {
    const q = pg.compileDDL(alterTable("orders").noForceRowLevelSecurity().build())
    expect(q.sql).toBe('ALTER TABLE "orders" NO FORCE ROW LEVEL SECURITY')
  })

  it("via db.schema.alterTable() — ENABLE", () => {
    const q = pg.compileDDL(pg.schema.alterTable("orders").enableRowLevelSecurity().build())
    expect(q.sql).toBe('ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY')
  })

  it("RLS toggle batches with other PG actions (PG groups multi-action ALTER TABLE)", () => {
    // Adding a column + enabling RLS in the same builder chain should
    // emit one statement on PG. Stays consistent with how other
    // multi-action ALTER TABLE calls render.
    const q = pg.compileDDL(
      alterTable("orders").addColumn("note", "text").enableRowLevelSecurity().build(),
    )
    expect(q.sql).toBe('ALTER TABLE "orders" ADD COLUMN "note" text, ENABLE ROW LEVEL SECURITY')
  })

  it("schema-qualified table", () => {
    const q = pg.compileDDL(alterTable("orders", "shop").enableRowLevelSecurity().build())
    expect(q.sql).toBe('ALTER TABLE "shop"."orders" ENABLE ROW LEVEL SECURITY')
  })
})

describe("non-PG dialects refuse every RLS surface", () => {
  const dialects = [
    ["MySQL", mysqlDialect()],
    ["SQLite", sqliteDialect()],
    ["MSSQL", mssqlDialect()],
  ] as const

  for (const [label, dialect] of dialects) {
    describe(label, () => {
      const db = sumak({ dialect, tables: {} })

      it("CREATE POLICY refuses", () => {
        expect(() => db.compileDDL(createPolicy("p").on("t").build())).toThrow(
          UnsupportedDialectFeatureError,
        )
      })

      it("DROP POLICY refuses", () => {
        expect(() => db.compileDDL(dropPolicy("p").on("t").build())).toThrow(
          UnsupportedDialectFeatureError,
        )
      })

      it("ALTER TABLE ENABLE ROW LEVEL SECURITY refuses", () => {
        expect(() => db.compileDDL(alterTable("t").enableRowLevelSecurity().build())).toThrow(
          UnsupportedDialectFeatureError,
        )
      })

      it("ALTER TABLE DISABLE ROW LEVEL SECURITY refuses", () => {
        expect(() => db.compileDDL(alterTable("t").disableRowLevelSecurity().build())).toThrow(
          UnsupportedDialectFeatureError,
        )
      })

      it("ALTER TABLE FORCE ROW LEVEL SECURITY refuses", () => {
        expect(() => db.compileDDL(alterTable("t").forceRowLevelSecurity().build())).toThrow(
          UnsupportedDialectFeatureError,
        )
      })

      it("ALTER TABLE NO FORCE ROW LEVEL SECURITY refuses", () => {
        expect(() => db.compileDDL(alterTable("t").noForceRowLevelSecurity().build())).toThrow(
          UnsupportedDialectFeatureError,
        )
      })
    })
  }
})

describe("PGlite roundtrip — RLS filters rows by tenant_id", () => {
  let pgInstance: PGlite

  beforeAll(async () => {
    pgInstance = new PGlite()
  })

  afterAll(async () => {
    await pgInstance?.close()
  })

  it("ENABLE RLS + CREATE POLICY restricts SELECT to current tenant", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgInstance), tables: {} })

    await pgInstance.query(
      `CREATE TABLE rls_orders (id serial PRIMARY KEY, tenant_id int, note text)`,
    )
    await pgInstance.query(
      `INSERT INTO rls_orders (tenant_id, note) VALUES (1, 'a'), (1, 'b'), (2, 'c'), (3, 'd')`,
    )

    // Enable RLS via the typed builder.
    await db.executeCompiledNoRows(
      db.compileDDL(alterTable("rls_orders").enableRowLevelSecurity().build()),
    )

    // Per-tenant policy via the typed builder.
    await db.executeCompiledNoRows(
      db.compileDDL(
        createPolicy("tenant_isolation")
          .on("rls_orders")
          .for("ALL")
          .using(sql<boolean>`tenant_id = current_setting('app.tenant_id')::int`)
          .withCheck(sql<boolean>`tenant_id = current_setting('app.tenant_id')::int`)
          .build(),
      ),
    )

    // PGlite logs in as a superuser; PG superusers bypass RLS unless
    // SET ROLE switches the current_user to a non-superuser without
    // BYPASSRLS. Create one and switch.
    await pgInstance.query(`CREATE ROLE rls_app_user NOSUPERUSER NOBYPASSRLS`)
    await pgInstance.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON rls_orders TO rls_app_user`)
    await pgInstance.query(`SET ROLE rls_app_user`)

    // Tenant 1 — two rows.
    await pgInstance.query(`SET app.tenant_id = '1'`)
    const r1 = await pgInstance.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rls_orders`,
    )
    expect(Number(r1.rows[0]!.count)).toBe(2)

    // Tenant 2 — one row.
    await pgInstance.query(`SET app.tenant_id = '2'`)
    const r2 = await pgInstance.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rls_orders`,
    )
    expect(Number(r2.rows[0]!.count)).toBe(1)

    // Tenant 4 — zero rows even though four rows exist.
    await pgInstance.query(`SET app.tenant_id = '4'`)
    const r4 = await pgInstance.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rls_orders`,
    )
    expect(Number(r4.rows[0]!.count)).toBe(0)

    // Reset to superuser, drop policy + disable RLS — back to full visibility.
    await pgInstance.query(`RESET ROLE`)
    await db.executeCompiledNoRows(
      db.compileDDL(dropPolicy("tenant_isolation").on("rls_orders").ifExists().build()),
    )
    await db.executeCompiledNoRows(
      db.compileDDL(alterTable("rls_orders").disableRowLevelSecurity().build()),
    )

    await pgInstance.query(`SET ROLE rls_app_user`)
    await pgInstance.query(`SET app.tenant_id = '4'`)
    const after = await pgInstance.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rls_orders`,
    )
    expect(Number(after.rows[0]!.count)).toBe(4)

    await pgInstance.query(`RESET ROLE`)
    await pgInstance.query(`REVOKE ALL ON rls_orders FROM rls_app_user`)
    await pgInstance.query(`DROP ROLE rls_app_user`)
    await pgInstance.query(`DROP TABLE rls_orders`)
  })

  it("WITH CHECK rejects an INSERT from the wrong tenant", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgInstance), tables: {} })

    await pgInstance.query(`CREATE TABLE rls_writes (id serial PRIMARY KEY, tenant_id int)`)
    await db.executeCompiledNoRows(
      db.compileDDL(alterTable("rls_writes").enableRowLevelSecurity().build()),
    )
    await db.executeCompiledNoRows(
      db.compileDDL(
        createPolicy("write_isolation")
          .on("rls_writes")
          .for("ALL")
          .using(sql<boolean>`tenant_id = current_setting('app.tenant_id')::int`)
          .withCheck(sql<boolean>`tenant_id = current_setting('app.tenant_id')::int`)
          .build(),
      ),
    )
    await pgInstance.query(`CREATE ROLE rls_write_user NOSUPERUSER NOBYPASSRLS`)
    await pgInstance.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON rls_writes TO rls_write_user`)
    await pgInstance.query(`GRANT USAGE, SELECT ON SEQUENCE rls_writes_id_seq TO rls_write_user`)
    await pgInstance.query(`SET ROLE rls_write_user`)

    await pgInstance.query(`SET app.tenant_id = '7'`)
    await pgInstance.query(`INSERT INTO rls_writes (tenant_id) VALUES (7)`)

    // Wrong tenant_id is rejected by the WITH CHECK predicate.
    await expect(pgInstance.query(`INSERT INTO rls_writes (tenant_id) VALUES (8)`)).rejects.toThrow(
      /row-level security/i,
    )

    // Cleanup
    await pgInstance.query(`RESET ROLE`)
    await db.executeCompiledNoRows(
      db.compileDDL(dropPolicy("write_isolation").on("rls_writes").build()),
    )
    await pgInstance.query(`REVOKE ALL ON rls_writes FROM rls_write_user`)
    await pgInstance.query(`REVOKE ALL ON SEQUENCE rls_writes_id_seq FROM rls_write_user`)
    await pgInstance.query(`DROP ROLE rls_write_user`)
    await pgInstance.query(`DROP TABLE rls_writes`)
  })
})
