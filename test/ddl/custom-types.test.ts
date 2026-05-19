import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { SecurityError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { createDomain, createTypeEnum, dropDomain, dropType, sql } from "../../src/index.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })

describe("CREATE TYPE AS ENUM — builder shape", () => {
  it("createTypeEnum(name) returns an empty-values node", () => {
    const node = createTypeEnum("mood").build()
    expect(node).toMatchObject({ type: "create_type_enum", name: "mood", values: [] })
  })

  it("createTypeEnum(name, ...vals) carries inline values", () => {
    const node = createTypeEnum("mood", "sad", "happy", "ecstatic").build()
    expect(node.values).toEqual(["sad", "happy", "ecstatic"])
  })

  it(".values(...) replaces the value list", () => {
    const node = createTypeEnum("mood", "old").values("a", "b").build()
    expect(node.values).toEqual(["a", "b"])
  })

  it("build() returns an independent copy of the values array", () => {
    const b = createTypeEnum("mood", "a", "b")
    const n = b.build()
    n.values.push("c")
    const fresh = b.build()
    expect(fresh.values).toEqual(["a", "b"])
  })
})

describe("CREATE TYPE AS ENUM — PG emission", () => {
  it("basic 3-value enum", () => {
    const q = pg.compileDDL(createTypeEnum("mood").values("sad", "happy", "ecstatic").build())
    expect(q.sql).toBe(`CREATE TYPE "mood" AS ENUM ('sad', 'happy', 'ecstatic')`)
  })

  it("inline form is identical to chained .values()", () => {
    const a = pg.compileDDL(createTypeEnum("mood", "sad", "happy", "ecstatic").build())
    const b = pg.compileDDL(createTypeEnum("mood").values("sad", "happy", "ecstatic").build())
    expect(a.sql).toBe(b.sql)
  })

  it("single-value enum is legal", () => {
    const q = pg.compileDDL(createTypeEnum("only").values("solo").build())
    expect(q.sql).toBe(`CREATE TYPE "only" AS ENUM ('solo')`)
  })

  it("empty-value enum is legal (PG allows it, values added via ALTER TYPE later)", () => {
    const q = pg.compileDDL(createTypeEnum("placeholder").build())
    expect(q.sql).toBe(`CREATE TYPE "placeholder" AS ENUM ()`)
  })

  it("escapes single quotes in values", () => {
    const q = pg.compileDDL(createTypeEnum("quoted").values("o'reilly", "smith").build())
    expect(q.sql).toBe(`CREATE TYPE "quoted" AS ENUM ('o''reilly', 'smith')`)
  })

  it("escapes backslashes in values", () => {
    const q = pg.compileDDL(createTypeEnum("escaped").values("a\\b", "c").build())
    expect(q.sql).toBe(`CREATE TYPE "escaped" AS ENUM ('a\\\\b', 'c')`)
  })

  it("via db.schema.createTypeEnum()", () => {
    const q = pg.compileDDL(pg.schema.createTypeEnum("mood", "sad", "happy").build())
    expect(q.sql).toBe(`CREATE TYPE "mood" AS ENUM ('sad', 'happy')`)
  })

  it("rejects names that violate the identifier grammar", () => {
    expect(() =>
      pg.compileDDL(createTypeEnum("mood; DROP TABLE users").values("a").build()),
    ).toThrow(SecurityError)
  })

  it("rejects names with a quote in them", () => {
    expect(() => pg.compileDDL(createTypeEnum("foo'bar").values("a").build())).toThrow(
      SecurityError,
    )
  })
})

describe("CREATE TYPE AS ENUM — refused on other dialects", () => {
  for (const [label, dialect] of [
    ["mysql", mysqlDialect],
    ["sqlite", sqliteDialect],
    ["mssql", mssqlDialect],
  ] as const) {
    it(`${label} refuses CREATE TYPE … AS ENUM`, () => {
      const db = sumak({ dialect: dialect(), tables: {} })
      expect(() => db.compileDDL(createTypeEnum("mood", "a", "b").build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  }
})

describe("DROP TYPE — builder shape", () => {
  it("dropType(name) — single name list", () => {
    const node = dropType("mood").build()
    expect(node).toMatchObject({ type: "drop_type", names: ["mood"] })
  })

  it("dropType([name1, name2]) — multi-name list", () => {
    const node = dropType(["mood", "status"]).build()
    expect(node.names).toEqual(["mood", "status"])
  })

  it("ifExists / cascade / restrict flags", () => {
    const a = dropType("mood").ifExists().build()
    expect(a.ifExists).toBe(true)
    const b = dropType("mood").cascade().build()
    expect(b.cascade).toBe(true)
    const c = dropType("mood").restrict().build()
    expect(c.restrict).toBe(true)
  })

  it("build() returns an independent copy of the names array", () => {
    const b = dropType(["a", "b"])
    const n = b.build()
    n.names.push("c")
    const fresh = b.build()
    expect(fresh.names).toEqual(["a", "b"])
  })
})

describe("DROP TYPE — PG emission", () => {
  it("basic DROP TYPE", () => {
    const q = pg.compileDDL(dropType("mood").build())
    expect(q.sql).toBe(`DROP TYPE "mood"`)
  })

  it("DROP TYPE IF EXISTS", () => {
    const q = pg.compileDDL(dropType("mood").ifExists().build())
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "mood"`)
  })

  it("DROP TYPE IF EXISTS … CASCADE", () => {
    const q = pg.compileDDL(dropType("mood").ifExists().cascade().build())
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "mood" CASCADE`)
  })

  it("multi-name list", () => {
    const q = pg.compileDDL(dropType(["mood", "status"]).ifExists().build())
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "mood", "status"`)
  })

  it("RESTRICT is omitted (it's the SQL default)", () => {
    const q = pg.compileDDL(dropType("mood").restrict().build())
    expect(q.sql).toBe(`DROP TYPE "mood"`)
  })

  it("rejects cascade + restrict combo", () => {
    expect(() => pg.compileDDL(dropType("mood").cascade().restrict().build())).toThrow(
      /mutually exclusive/,
    )
  })

  it("rejects empty names list (hand-built AST)", () => {
    const bad = { type: "drop_type", names: [] } as unknown as Parameters<typeof pg.compileDDL>[0]
    expect(() => pg.compileDDL(bad)).toThrow(/at least one type name/)
  })

  it("via db.schema.dropType()", () => {
    const q = pg.compileDDL(pg.schema.dropType(["a", "b"]).ifExists().cascade().build())
    expect(q.sql).toBe(`DROP TYPE IF EXISTS "a", "b" CASCADE`)
  })
})

describe("DROP TYPE — refused on other dialects", () => {
  for (const [label, dialect] of [
    ["mysql", mysqlDialect],
    ["sqlite", sqliteDialect],
    ["mssql", mssqlDialect],
  ] as const) {
    it(`${label} refuses DROP TYPE`, () => {
      const db = sumak({ dialect: dialect(), tables: {} })
      expect(() => db.compileDDL(dropType("mood").build())).toThrow(UnsupportedDialectFeatureError)
    })
  }
})

describe("CREATE DOMAIN — builder shape", () => {
  it("createDomain(name) leaves dataType empty until .dataType()", () => {
    const node = createDomain("email").build()
    expect(node).toMatchObject({ type: "create_domain", name: "email", dataType: "" })
  })

  it("createDomain(name, type) inline form", () => {
    const node = createDomain("email", "text").build()
    expect(node).toMatchObject({ name: "email", dataType: "text" })
  })

  it(".dataType(t) updates the wrapped type", () => {
    const node = createDomain("email").dataType("text").build()
    expect(node.dataType).toBe("text")
  })

  it(".notNull() sets the flag", () => {
    const node = createDomain("e", "text").notNull().build()
    expect(node.notNull).toBe(true)
  })

  it(".defaultTo(expr) carries the expression node", () => {
    const node = createDomain("status", "text")
      .defaultTo(sql`'active'`)
      .build()
    expect(node.defaultExpression).toBeDefined()
  })

  it(".check(expr) carries the expression node", () => {
    const node = createDomain("email", "text")
      .check(sql<boolean>`value ~ '^[^@]+@[^@]+$'`)
      .build()
    expect(node.check).toBeDefined()
    expect(node.checkConstraintName).toBeUndefined()
  })

  it(".check(expr, name) sets the constraint name", () => {
    const node = createDomain("email", "text")
      .check(sql<boolean>`value ~ '^[^@]+@[^@]+$'`, "email_format")
      .build()
    expect(node.checkConstraintName).toBe("email_format")
  })
})

describe("CREATE DOMAIN — PG emission", () => {
  it("bare form (just name + type)", () => {
    const q = pg.compileDDL(createDomain("email", "text").build())
    expect(q.sql).toBe(`CREATE DOMAIN "email" AS text`)
  })

  it("with CHECK constraint", () => {
    const q = pg.compileDDL(
      createDomain("email", "text")
        .check(sql<boolean>`value ~ '^[^@]+@[^@]+$'`)
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "email" AS text CHECK (value ~ '^[^@]+@[^@]+$')`)
  })

  it("with named CHECK constraint", () => {
    const q = pg.compileDDL(
      createDomain("email", "text")
        .check(sql<boolean>`value ~ '^[^@]+@[^@]+$'`, "email_format")
        .build(),
    )
    expect(q.sql).toBe(
      `CREATE DOMAIN "email" AS text CONSTRAINT "email_format" CHECK (value ~ '^[^@]+@[^@]+$')`,
    )
  })

  it("with NOT NULL", () => {
    const q = pg.compileDDL(createDomain("pos_int", "integer").notNull().build())
    expect(q.sql).toBe(`CREATE DOMAIN "pos_int" AS integer NOT NULL`)
  })

  it("with DEFAULT", () => {
    const q = pg.compileDDL(
      createDomain("status", "text")
        .defaultTo(sql`'active'`)
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "status" AS text DEFAULT 'active'`)
  })

  it("with DEFAULT + CHECK + NOT NULL — order DEFAULT, CHECK, NOT NULL", () => {
    const q = pg.compileDDL(
      createDomain("pos_int", "integer")
        .defaultTo(sql`0`)
        .check(sql<boolean>`value >= 0`)
        .notNull()
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "pos_int" AS integer DEFAULT 0 CHECK (value >= 0) NOT NULL`)
  })

  it("with parameterised data type", () => {
    const q = pg.compileDDL(createDomain("short_name", "varchar(50)").notNull().build())
    expect(q.sql).toBe(`CREATE DOMAIN "short_name" AS varchar(50) NOT NULL`)
  })

  it("via db.schema.createDomain()", () => {
    const q = pg.compileDDL(
      pg.schema
        .createDomain("email", "text")
        .check(sql<boolean>`value LIKE '%@%'`)
        .build(),
    )
    expect(q.sql).toBe(`CREATE DOMAIN "email" AS text CHECK (value LIKE '%@%')`)
  })

  it("rejects empty data type (forgot .dataType())", () => {
    expect(() => pg.compileDDL(createDomain("email").build())).toThrow(/requires a data type/)
  })

  it("rejects names that violate the identifier grammar", () => {
    expect(() => pg.compileDDL(createDomain("email; DROP TABLE users", "text").build())).toThrow(
      SecurityError,
    )
  })

  it("rejects unsafe data types", () => {
    expect(() => pg.compileDDL(createDomain("e", "text; DROP TABLE users").build())).toThrow()
  })

  it("rejects unsafe constraint names", () => {
    expect(() =>
      pg.compileDDL(
        createDomain("e", "text")
          .check(sql<boolean>`true`, "bad name; DROP TABLE")
          .build(),
      ),
    ).toThrow(SecurityError)
  })
})

describe("CREATE DOMAIN — refused on other dialects", () => {
  for (const [label, dialect] of [
    ["mysql", mysqlDialect],
    ["sqlite", sqliteDialect],
    ["mssql", mssqlDialect],
  ] as const) {
    it(`${label} refuses CREATE DOMAIN`, () => {
      const db = sumak({ dialect: dialect(), tables: {} })
      expect(() => db.compileDDL(createDomain("e", "text").build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  }
})

describe("DROP DOMAIN — builder shape", () => {
  it("dropDomain(name) — single-name list", () => {
    const node = dropDomain("email").build()
    expect(node).toMatchObject({ type: "drop_domain", names: ["email"] })
  })

  it("dropDomain([n1, n2]) — multi-name", () => {
    const node = dropDomain(["a", "b"]).build()
    expect(node.names).toEqual(["a", "b"])
  })

  it("ifExists / cascade / restrict flags", () => {
    expect(dropDomain("a").ifExists().build().ifExists).toBe(true)
    expect(dropDomain("a").cascade().build().cascade).toBe(true)
    expect(dropDomain("a").restrict().build().restrict).toBe(true)
  })
})

describe("DROP DOMAIN — PG emission", () => {
  it("basic DROP DOMAIN", () => {
    const q = pg.compileDDL(dropDomain("email").build())
    expect(q.sql).toBe(`DROP DOMAIN "email"`)
  })

  it("DROP DOMAIN IF EXISTS … CASCADE", () => {
    const q = pg.compileDDL(dropDomain("email").ifExists().cascade().build())
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "email" CASCADE`)
  })

  it("multi-name list", () => {
    const q = pg.compileDDL(dropDomain(["email", "url"]).ifExists().build())
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "email", "url"`)
  })

  it("rejects cascade + restrict combo", () => {
    expect(() => pg.compileDDL(dropDomain("email").cascade().restrict().build())).toThrow(
      /mutually exclusive/,
    )
  })

  it("rejects empty names list (hand-built AST)", () => {
    const bad = { type: "drop_domain", names: [] } as unknown as Parameters<typeof pg.compileDDL>[0]
    expect(() => pg.compileDDL(bad)).toThrow(/at least one domain name/)
  })

  it("via db.schema.dropDomain()", () => {
    const q = pg.compileDDL(pg.schema.dropDomain("email").ifExists().build())
    expect(q.sql).toBe(`DROP DOMAIN IF EXISTS "email"`)
  })
})

describe("DROP DOMAIN — refused on other dialects", () => {
  for (const [label, dialect] of [
    ["mysql", mysqlDialect],
    ["sqlite", sqliteDialect],
    ["mssql", mssqlDialect],
  ] as const) {
    it(`${label} refuses DROP DOMAIN`, () => {
      const db = sumak({ dialect: dialect(), tables: {} })
      expect(() => db.compileDDL(dropDomain("email").build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  }
})

describe("PGlite roundtrip — enum types and domains end to end", () => {
  let pgInstance: PGlite

  beforeAll(async () => {
    pgInstance = new PGlite()
  })

  afterAll(async () => {
    await pgInstance?.close()
  })

  it("creates an enum type, uses it as a column type, and rejects out-of-range values", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgInstance), tables: {} })

    // Create the enum type.
    await db.executeCompiledNoRows(
      db.compileDDL(createTypeEnum("mood_t").values("sad", "happy", "ecstatic").build()),
    )

    // Use the enum as a column type. (CREATE TABLE doesn't go through
    // the sumak schema layer here — we run it as raw PGlite SQL so the
    // test stays focused on the enum DDL itself.)
    await pgInstance.query(`CREATE TABLE feelings (id serial PRIMARY KEY, mood mood_t)`)
    await pgInstance.query(`INSERT INTO feelings (mood) VALUES ('happy'), ('sad')`)

    const r = await pgInstance.query<{ mood: string }>(`SELECT mood FROM feelings ORDER BY id`)
    expect(r.rows.map((row) => row.mood)).toEqual(["happy", "sad"])

    // Out-of-range value → PG raises at the engine.
    await expect(
      pgInstance.query(`INSERT INTO feelings (mood) VALUES ('confused')`),
    ).rejects.toThrow(/invalid input value for enum/)

    // Enum values sort in their declared order: sad < happy < ecstatic.
    await pgInstance.query(`INSERT INTO feelings (mood) VALUES ('ecstatic')`)
    const ordered = await pgInstance.query<{ mood: string }>(
      `SELECT mood FROM feelings ORDER BY mood`,
    )
    expect(ordered.rows.map((row) => row.mood)).toEqual(["sad", "happy", "ecstatic"])

    // Cleanup (CASCADE drops the dependent table column).
    await pgInstance.query(`DROP TABLE feelings`)
    await db.executeCompiledNoRows(db.compileDDL(dropType("mood_t").ifExists().build()))
  })

  it("creates a CHECK domain, accepts valid values, rejects invalid ones", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgInstance), tables: {} })

    // Create the domain.
    await db.executeCompiledNoRows(
      db.compileDDL(
        createDomain("email_t", "text")
          .check(sql<boolean>`value LIKE '%@%'`, "email_must_have_at")
          .build(),
      ),
    )

    await pgInstance.query(`CREATE TABLE users (id serial PRIMARY KEY, email email_t)`)

    // Valid email — accepted.
    await pgInstance.query(`INSERT INTO users (email) VALUES ('alice@example.com')`)
    const r = await pgInstance.query<{ email: string }>(`SELECT email FROM users`)
    expect(r.rows[0]!.email).toBe("alice@example.com")

    // Invalid email — rejected by the domain CHECK.
    await expect(
      pgInstance.query(`INSERT INTO users (email) VALUES ('not-an-email')`),
    ).rejects.toThrow(/violates check constraint/i)

    // Cleanup.
    await pgInstance.query(`DROP TABLE users`)
    await db.executeCompiledNoRows(db.compileDDL(dropDomain("email_t").ifExists().build()))
  })

  it("DROP TYPE IF EXISTS is idempotent", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgInstance), tables: {} })

    await db.executeCompiledNoRows(
      db.compileDDL(createTypeEnum("status_t").values("a", "b").build()),
    )
    const dropSql = db.compileDDL(dropType("status_t").ifExists().build())
    await db.executeCompiledNoRows(dropSql)
    // Re-drop — must not throw thanks to IF EXISTS.
    await db.executeCompiledNoRows(dropSql)
  })
})
