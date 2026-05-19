import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  CreateDomainBuilder,
  CreateTypeEnumBuilder,
  DropDomainBuilder,
  DropTypeBuilder,
} from "../../src/builder/ddl/custom-types.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { SecurityError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { createDomain, createTypeEnum, dropDomain, dropType, sql } from "../../src/index.ts"
import { DDLPrinter } from "../../src/printer/ddl.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })
const my = sumak({ dialect: mysqlDialect(), tables: {} })
const sqlite = sumak({ dialect: sqliteDialect(), tables: {} })
const mssql = sumak({ dialect: mssqlDialect(), tables: {} })

// ─────────────────────────────────────────────────────────────────────
// CREATE TYPE AS ENUM
// ─────────────────────────────────────────────────────────────────────

describe("CREATE TYPE AS ENUM — builder shape", () => {
  it("createTypeEnum(name) seeds an empty values list", () => {
    const node = createTypeEnum("status").build()
    expect(node).toEqual({ type: "create_type_enum", name: "status", values: [] })
  })

  it(".values(rest...) accepts a rest list of strings", () => {
    const node = createTypeEnum("status").values("a", "b", "c").build()
    expect(node.values).toEqual(["a", "b", "c"])
  })

  it(".values(array) accepts a single string[] argument", () => {
    const node = createTypeEnum("status").values(["a", "b"]).build()
    expect(node.values).toEqual(["a", "b"])
  })

  it("each .values() call REPLACES the previous list (idempotent)", () => {
    // Calling `.values()` more than once replaces — the chain re-roots
    // the label set rather than appending. Matches the documented
    // behavior and prevents accidental duplication.
    const node = createTypeEnum("status").values("x").values("a", "b").build()
    expect(node.values).toEqual(["a", "b"])
  })

  it("builder is immutable — branching the chain returns independent nodes", () => {
    const a = createTypeEnum("status")
    const b = a.values("a", "b")
    expect(a.build().values).toEqual([])
    expect(b.build().values).toEqual(["a", "b"])
  })

  it("build() returns a fresh array (mutating it doesn't poison the builder)", () => {
    const b = createTypeEnum("status").values("a", "b")
    const node = b.build()
    node.values.push("c")
    expect(b.build().values).toEqual(["a", "b"])
  })
})

describe("CREATE TYPE AS ENUM — PG emission", () => {
  it("emits with multiple values", () => {
    const q = pg.compileDDL(createTypeEnum("order_status").values("pending", "paid").build())
    expect(q.sql).toBe(`CREATE TYPE "order_status" AS ENUM ('pending', 'paid')`)
    expect(q.params).toEqual([])
  })

  it("emits with a single value", () => {
    const q = pg.compileDDL(createTypeEnum("color").values("red").build())
    expect(q.sql).toBe(`CREATE TYPE "color" AS ENUM ('red')`)
  })

  it("emits an empty enum (PG accepts it, though it's rarely useful)", () => {
    const q = pg.compileDDL(createTypeEnum("empty").build())
    expect(q.sql).toBe(`CREATE TYPE "empty" AS ENUM ()`)
  })

  it("escapes single quotes in label values", () => {
    // A label like `O'Brien` must be doubled to `O''Brien` to survive
    // the splice into the SQL literal slot.
    const q = pg.compileDDL(createTypeEnum("name").values("O'Brien", "ok").build())
    expect(q.sql).toBe(`CREATE TYPE "name" AS ENUM ('O''Brien', 'ok')`)
  })

  it("escapes backslashes in label values (MySQL backslash-escape safety)", () => {
    // Doubled by escapeStringLiteral — defensive against PG running in a
    // mode that interprets backslashes.
    const q = pg.compileDDL(createTypeEnum("foo").values("a\\b").build())
    expect(q.sql).toBe(`CREATE TYPE "foo" AS ENUM ('a\\\\b')`)
  })

  it("preserves declared order (which is the sort order in PG)", () => {
    // The label order is load-bearing in PG — ORDER BY on an enum-typed
    // column sorts by the declared sequence, not lexicographic text.
    const q = pg.compileDDL(createTypeEnum("priority").values("high", "low", "medium").build())
    expect(q.sql).toBe(`CREATE TYPE "priority" AS ENUM ('high', 'low', 'medium')`)
  })
})

// ─────────────────────────────────────────────────────────────────────
// DROP TYPE
// ─────────────────────────────────────────────────────────────────────

describe("DROP TYPE — builder shape", () => {
  it("accepts a single name", () => {
    const node = dropType("foo").build()
    expect(node.names).toEqual(["foo"])
  })

  it("accepts an array of names", () => {
    const node = dropType(["a", "b"]).build()
    expect(node.names).toEqual(["a", "b"])
  })

  it("defensively copies the names array", () => {
    const src = ["a", "b"]
    const node = dropType(src).build()
    src.push("c")
    expect(node.names).toEqual(["a", "b"])
  })

  it("build() copies the names array each time", () => {
    const b = dropType(["a", "b"])
    const n = b.build()
    n.names.push("c")
    expect(b.build().names).toEqual(["a", "b"])
  })

  it("CASCADE → RESTRICT flips to RESTRICT (last call wins)", () => {
    const node = dropType("t").cascade().restrict().build()
    expect(node.cascade).toBeUndefined()
    expect(node.restrict).toBe(true)
  })

  it("RESTRICT → CASCADE flips to CASCADE (last call wins)", () => {
    const node = dropType("t").restrict().cascade().build()
    expect(node.restrict).toBeUndefined()
    expect(node.cascade).toBe(true)
  })
})

describe("DROP TYPE — PG emission", () => {
  it("emits the bare form", () => {
    const q = pg.compileDDL(dropType("status").build())
    expect(q.sql).toBe(`DROP TYPE "status"`)
  })

  it("emits IF EXISTS … CASCADE", () => {
    const q = pg.compileDDL(dropType("status").ifExists().cascade().build())
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "status" CASCADE`)
  })

  it("emits RESTRICT", () => {
    const q = pg.compileDDL(dropType("status").restrict().build())
    expect(q.sql).toBe(`DROP TYPE "status" RESTRICT`)
  })

  it("emits a comma-separated list", () => {
    const q = pg.compileDDL(dropType(["a", "b", "c"]).build())
    expect(q.sql).toBe(`DROP TYPE "a", "b", "c"`)
  })

  it("emits IF EXISTS + list + CASCADE together", () => {
    const q = pg.compileDDL(dropType(["a", "b"]).ifExists().cascade().build())
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "a", "b" CASCADE`)
  })

  it("hand-rolled AST with empty names list throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_type",
        names: [],
      }),
    ).toThrow(/at least one/i)
  })

  it("hand-rolled AST with both CASCADE and RESTRICT throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_type",
        names: ["foo"],
        cascade: true,
        restrict: true,
      }),
    ).toThrow(/mutually exclusive/i)
  })
})

// ─────────────────────────────────────────────────────────────────────
// CREATE DOMAIN
// ─────────────────────────────────────────────────────────────────────

describe("CREATE DOMAIN — builder shape", () => {
  it("createDomain(name) seeds an empty dataType", () => {
    const node = createDomain("d").build()
    expect(node).toMatchObject({ type: "create_domain", name: "d", dataType: "" })
  })

  it("createDomain(name, type) seeds the dataType", () => {
    const node = createDomain("d", "integer").build()
    expect(node.dataType).toBe("integer")
  })

  it(".dataType(type) sets/overrides the base type", () => {
    const node = createDomain("d").dataType("integer").build()
    expect(node.dataType).toBe("integer")
  })

  it(".notNull() sets the flag", () => {
    const node = createDomain("d", "integer").notNull().build()
    expect(node.notNull).toBe(true)
  })

  it(".defaultTo(sql) sets the expression", () => {
    const node = createDomain("d", "integer")
      .defaultTo(sql`0`)
      .build()
    expect(node.defaultExpression).toBeDefined()
  })

  it(".check(sql) sets the expression", () => {
    const node = createDomain("d", "integer")
      .check(sql<boolean>`VALUE > 0`)
      .build()
    expect(node.check).toBeDefined()
    expect(node.checkConstraintName).toBeUndefined()
  })

  it(".check(sql, name) records the constraint name too", () => {
    const node = createDomain("d", "integer")
      .check(sql<boolean>`VALUE > 0`, "positive_check")
      .build()
    expect(node.checkConstraintName).toBe("positive_check")
  })

  it("builder is immutable — branching returns independent nodes", () => {
    const a = createDomain("d", "integer")
    const b = a.notNull()
    expect(a.build().notNull).toBeUndefined()
    expect(b.build().notNull).toBe(true)
  })
})

describe("CREATE DOMAIN — PG emission", () => {
  it("bare form — name + dataType", () => {
    const q = pg.compileDDL(createDomain("d", "integer").build())
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer`)
  })

  it("dataType set via .dataType() chain", () => {
    const q = pg.compileDDL(createDomain("d").dataType("integer").build())
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer`)
  })

  it("NOT NULL", () => {
    const q = pg.compileDDL(createDomain("d", "integer").notNull().build())
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer NOT NULL`)
  })

  it("DEFAULT", () => {
    const q = pg.compileDDL(
      createDomain("d", "integer")
        .defaultTo(sql`0`)
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer DEFAULT 0`)
  })

  it("CHECK", () => {
    const q = pg.compileDDL(
      createDomain("d", "integer")
        .check(sql<boolean>`VALUE > 0`)
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer CHECK (VALUE > 0)`)
  })

  it("CHECK with named constraint", () => {
    const q = pg.compileDDL(
      createDomain("d", "integer")
        .check(sql<boolean>`VALUE > 0`, "positive_check")
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer CONSTRAINT "positive_check" CHECK (VALUE > 0)`)
  })

  it("all options combined — DEFAULT + NOT NULL + named CHECK", () => {
    const q = pg.compileDDL(
      createDomain("positive_int", "integer")
        .defaultTo(sql`1`)
        .notNull()
        .check(sql<boolean>`VALUE > 0`, "positive_int_check")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE DOMAIN "positive_int" AS integer DEFAULT 1 NOT NULL ` +
        `CONSTRAINT "positive_int_check" CHECK (VALUE > 0)`,
    )
  })

  it("complex base type — varchar(120) survives validateDataType", () => {
    const q = pg.compileDDL(createDomain("short_text", "varchar(120)").notNull().build())
    expect(q.sql).toBe(`CREATE DOMAIN "short_text" AS varchar(120) NOT NULL`)
  })

  it("hand-rolled AST with empty dataType throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "create_domain",
        name: "d",
        dataType: "",
      }),
    ).toThrow(/requires a base data type/i)
  })
})

// ─────────────────────────────────────────────────────────────────────
// DROP DOMAIN
// ─────────────────────────────────────────────────────────────────────

describe("DROP DOMAIN — builder + PG emission", () => {
  it("emits the bare form", () => {
    const q = pg.compileDDL(dropDomain("positive_int").build())
    expect(q.sql).toBe(`DROP DOMAIN "positive_int"`)
  })

  it("IF EXISTS", () => {
    const q = pg.compileDDL(dropDomain("positive_int").ifExists().build())
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "positive_int"`)
  })

  it("CASCADE", () => {
    const q = pg.compileDDL(dropDomain("positive_int").cascade().build())
    expect(q.sql).toBe(`DROP DOMAIN "positive_int" CASCADE`)
  })

  it("RESTRICT", () => {
    const q = pg.compileDDL(dropDomain("positive_int").restrict().build())
    expect(q.sql).toBe(`DROP DOMAIN "positive_int" RESTRICT`)
  })

  it("multiple names", () => {
    const q = pg.compileDDL(dropDomain(["a", "b"]).build())
    expect(q.sql).toBe(`DROP DOMAIN "a", "b"`)
  })

  it("IF EXISTS + multiple + CASCADE", () => {
    const q = pg.compileDDL(dropDomain(["a", "b"]).ifExists().cascade().build())
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "a", "b" CASCADE`)
  })

  it("CASCADE → RESTRICT flips to RESTRICT (last call wins)", () => {
    const node = dropDomain("d").cascade().restrict().build()
    expect(node.cascade).toBeUndefined()
    expect(node.restrict).toBe(true)
  })

  it("hand-rolled AST with empty names throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_domain",
        names: [],
      }),
    ).toThrow(/at least one/i)
  })

  it("hand-rolled AST with both CASCADE and RESTRICT throws", () => {
    expect(() =>
      pg.compileDDL({
        type: "drop_domain",
        names: ["foo"],
        cascade: true,
        restrict: true,
      }),
    ).toThrow(/mutually exclusive/i)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Dialect feature gate — PG only
// ─────────────────────────────────────────────────────────────────────

describe("CUSTOM_TYPES is PostgreSQL-only", () => {
  const createEnum = (db: typeof pg) =>
    db.compileDDL(db.schema.createTypeEnum("e").values("a").build())
  const dropEnum = (db: typeof pg) => db.compileDDL(db.schema.dropType("e").build())
  const createDom = (db: typeof pg) => db.compileDDL(db.schema.createDomain("d", "integer").build())
  const dropDom = (db: typeof pg) => db.compileDDL(db.schema.dropDomain("d").build())

  it("MySQL: CREATE TYPE AS ENUM refused", () => {
    expect(() => createEnum(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: DROP TYPE refused", () => {
    expect(() => dropEnum(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: CREATE DOMAIN refused", () => {
    expect(() => createDom(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: DROP DOMAIN refused", () => {
    expect(() => dropDom(my as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: CREATE TYPE AS ENUM refused", () => {
    expect(() => createEnum(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: DROP TYPE refused", () => {
    expect(() => dropEnum(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: CREATE DOMAIN refused", () => {
    expect(() => createDom(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: DROP DOMAIN refused", () => {
    expect(() => dropDom(sqlite as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: CREATE TYPE AS ENUM refused", () => {
    expect(() => createEnum(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: DROP TYPE refused", () => {
    expect(() => dropEnum(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: CREATE DOMAIN refused", () => {
    expect(() => createDom(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL: DROP DOMAIN refused", () => {
    expect(() => dropDom(mssql as any)).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message names the CUSTOM_TYPES feature", () => {
    try {
      createEnum(my as any)
      throw new Error("unreachable")
    } catch (e) {
      expect((e as Error).message).toMatch(/CREATE TYPE \/ CREATE DOMAIN/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Name validators
// ─────────────────────────────────────────────────────────────────────

describe("Name validators reject injection", () => {
  // The type / domain names land in `quoteIdentifier`'s output but the
  // builder also gates them through `validateFunctionName` to reject
  // any non-identifier shape — keeps hand-crafted ASTs honest.
  const printer = new DDLPrinter("pg")

  it("CREATE TYPE: rejects injected name", () => {
    expect(() =>
      printer.print({
        type: "create_type_enum",
        name: "x; DROP TABLE users; --",
        values: ["a"],
      }),
    ).toThrow(SecurityError)
  })

  it("DROP TYPE: rejects injected name in list", () => {
    expect(() =>
      printer.print({
        type: "drop_type",
        names: ["good", "evil; DROP TABLE users"],
      }),
    ).toThrow(SecurityError)
  })

  it("CREATE DOMAIN: rejects injected name", () => {
    expect(() =>
      printer.print({
        type: "create_domain",
        name: "x';DROP",
        dataType: "integer",
      }),
    ).toThrow(SecurityError)
  })

  it("CREATE DOMAIN: rejects injected data type", () => {
    expect(() =>
      printer.print({
        type: "create_domain",
        name: "d",
        dataType: "integer; DROP TABLE",
      }),
    ).toThrow(SecurityError)
  })

  it("CREATE DOMAIN: rejects injected CHECK constraint name", () => {
    expect(() =>
      printer.print({
        type: "create_domain",
        name: "d",
        dataType: "integer",
        check: { type: "raw", sql: "VALUE > 0", params: [] },
        checkConstraintName: "evil; DROP",
      }),
    ).toThrow(SecurityError)
  })

  it("CREATE TYPE: enum values are escape-safe (single quote doubled)", () => {
    const r = printer.print({
      type: "create_type_enum",
      name: "e",
      values: ["O'Brien"],
    })
    expect(r.sql).toBe(`CREATE TYPE "e" AS ENUM ('O''Brien')`)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Standalone builder direct construction
// ─────────────────────────────────────────────────────────────────────

describe("Standalone builder classes", () => {
  it("CreateTypeEnumBuilder is constructable directly", () => {
    const node = new CreateTypeEnumBuilder("e").values("a").build()
    expect(node).toEqual({ type: "create_type_enum", name: "e", values: ["a"] })
  })

  it("DropTypeBuilder accepts a single name", () => {
    const node = new DropTypeBuilder("e").build()
    expect(node.names).toEqual(["e"])
  })

  it("DropTypeBuilder accepts an array", () => {
    const node = new DropTypeBuilder(["a", "b"]).build()
    expect(node.names).toEqual(["a", "b"])
  })

  it("CreateDomainBuilder is constructable directly", () => {
    const node = new CreateDomainBuilder("d", "integer").notNull().build()
    expect(node).toMatchObject({
      type: "create_domain",
      name: "d",
      dataType: "integer",
      notNull: true,
    })
  })

  it("DropDomainBuilder is constructable directly", () => {
    const node = new DropDomainBuilder("d").ifExists().build()
    expect(node).toMatchObject({ type: "drop_domain", names: ["d"], ifExists: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// db.compile() routes through DDL printer
// ─────────────────────────────────────────────────────────────────────

describe("db.compile() routes custom-type nodes through DDLPrinter", () => {
  it("CreateTypeEnumNode round-trips through compile()", () => {
    const node = pg.schema.createTypeEnum("e").values("a", "b").build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`CREATE TYPE "e" AS ENUM ('a', 'b')`)
  })

  it("DropTypeNode round-trips through compile()", () => {
    const node = pg.schema.dropType("e").ifExists().build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "e"`)
  })

  it("CreateDomainNode round-trips through compile()", () => {
    const node = pg.schema.createDomain("d", "integer").notNull().build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`CREATE DOMAIN "d" AS integer NOT NULL`)
  })

  it("DropDomainNode round-trips through compile()", () => {
    const node = pg.schema.dropDomain("d").ifExists().build()
    const q = pg.compile(node)
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "d"`)
  })
})

// ─────────────────────────────────────────────────────────────────────
// PGlite roundtrip — the emitted DDL parses + executes against a real
// PG parser. Covers the integration plane.
// ─────────────────────────────────────────────────────────────────────

describe("PGlite roundtrip — CREATE TYPE AS ENUM + CREATE DOMAIN", () => {
  let pgdb: PGlite
  let db: ReturnType<typeof sumak<{}>>

  beforeAll(async () => {
    pgdb = new PGlite()
    await pgdb.waitReady
    db = sumak({ dialect: pgDialect(), tables: {}, driver: pgliteDriver(pgdb) })
  })

  afterAll(async () => {
    await pgdb?.close()
  })

  it("creates an enum type, uses it as a column type, accepts/rejects values, drops it", async () => {
    // 1) Create the enum type.
    await pgdb.exec(
      db.compileDDL(
        db.schema.createTypeEnum("order_status").values("pending", "paid", "shipped").build(),
      ).sql,
    )

    // Verify it landed in pg_type.
    const typs = await pgdb.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname = 'order_status'`,
    )
    expect(typs.rows.map((r) => r.typname)).toEqual(["order_status"])

    // 2) Use the enum as a column type and insert valid values.
    await pgdb.exec(`
      CREATE TEMP TABLE orders (
        id serial PRIMARY KEY,
        status order_status NOT NULL
      )
    `)
    await pgdb.exec(`INSERT INTO orders (status) VALUES ('pending'), ('paid')`)

    const ok = await pgdb.query<{ status: string }>(`SELECT status FROM orders ORDER BY id`)
    expect(ok.rows.map((r) => r.status)).toEqual(["pending", "paid"])

    // 3) Inserting a value outside the declared label set must fail —
    //    that's the entire point of an enum type.
    await expect(pgdb.exec(`INSERT INTO orders (status) VALUES ('cancelled')`)).rejects.toThrow(
      /invalid input value for enum/i,
    )

    // 4) Drop the table first (depends on the type), then the type.
    await pgdb.exec(`DROP TABLE orders`)
    await pgdb.exec(db.compileDDL(db.schema.dropType("order_status").build()).sql)

    // Verify the type is gone.
    const after = await pgdb.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname = 'order_status'`,
    )
    expect(after.rows).toEqual([])
  })

  it("DROP TYPE IF EXISTS is idempotent", async () => {
    const sql = db.compileDDL(db.schema.dropType("never_existed").ifExists().build())
    await pgdb.exec(sql.sql)
    // Second drop must not throw either.
    await pgdb.exec(sql.sql)
  })

  it("creates a domain with CHECK, accepts/rejects values, drops it", async () => {
    // 1) Create the domain.
    await pgdb.exec(
      db.compileDDL(
        db.schema
          .createDomain("positive_int", "integer")
          .notNull()
          .check(sql<boolean>`VALUE > 0`, "positive_int_check")
          .build(),
      ).sql,
    )

    // 2) Use it as a column type.
    await pgdb.exec(`
      CREATE TEMP TABLE salaries (
        id serial PRIMARY KEY,
        amount positive_int
      )
    `)

    // 3) Valid insert.
    await pgdb.exec(`INSERT INTO salaries (amount) VALUES (100)`)
    const ok = await pgdb.query<{ amount: number }>(`SELECT amount FROM salaries ORDER BY id`)
    expect(ok.rows.map((r) => Number(r.amount))).toEqual([100])

    // 4) CHECK violation — must throw.
    await expect(pgdb.exec(`INSERT INTO salaries (amount) VALUES (-1)`)).rejects.toThrow(
      /violates check constraint/i,
    )

    // 5) NOT NULL violation — domain-level, must also throw.
    await expect(pgdb.exec(`INSERT INTO salaries (amount) VALUES (NULL)`)).rejects.toThrow(
      /domain positive_int does not allow null values|null value/i,
    )

    // 6) Cleanup.
    await pgdb.exec(`DROP TABLE salaries`)
    await pgdb.exec(db.compileDDL(db.schema.dropDomain("positive_int").build()).sql)
  })

  it("creates a domain with DEFAULT, the default is observed on insert", async () => {
    await pgdb.exec(
      db.compileDDL(
        db.schema
          .createDomain("age_dom", "integer")
          .defaultTo(sql`18`)
          .build(),
      ).sql,
    )

    await pgdb.exec(`
      CREATE TEMP TABLE people (
        id serial PRIMARY KEY,
        age age_dom
      )
    `)
    // Don't supply `age` — domain default should fire.
    await pgdb.exec(`INSERT INTO people (id) VALUES (DEFAULT)`)
    const r = await pgdb.query<{ age: number }>(`SELECT age FROM people`)
    expect(Number(r.rows[0]!.age)).toBe(18)

    await pgdb.exec(`DROP TABLE people`)
    await pgdb.exec(db.compileDDL(db.schema.dropDomain("age_dom").build()).sql)
  })
})
