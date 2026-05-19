import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { truncate } from "../../src/index.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

describe("TRUNCATE TABLE — builder shape", () => {
  it("truncate(string) wraps a single-table node", () => {
    const node = truncate("users").build()
    expect(node).toEqual({
      type: "truncate_table",
      tables: [{ type: "table_ref", name: "users" }],
    })
  })

  it("truncate(string[]) emits a multi-table node", () => {
    const node = truncate(["users", "orders"]).build()
    expect(node.tables.map((t) => t.name)).toEqual(["users", "orders"])
  })

  it("truncate({ name, schema }) carries the schema", () => {
    const node = truncate({ name: "events", schema: "audit" }).build()
    expect(node.tables[0]).toEqual({ type: "table_ref", name: "events", schema: "audit" })
  })

  it("rejects an empty list", () => {
    expect(() => truncate([])).toThrow(/at least one table/)
  })

  it("fluent chain — full PG grammar", () => {
    const node = truncate(["t1", "t2"]).only().restartIdentity().cascade().build()
    expect(node).toMatchObject({
      tables: [{ name: "t1" }, { name: "t2" }],
      only: true,
      restartIdentity: true,
      cascade: true,
    })
  })

  it("restartIdentity then continueIdentity flips the slot", () => {
    const node = truncate("t").restartIdentity().continueIdentity().build()
    expect(node.continueIdentity).toBe(true)
    expect(node.restartIdentity).toBe(false)
  })

  it("cascade then restrict flips the slot", () => {
    const node = truncate("t").cascade().restrict().build()
    expect(node.restrict).toBe(true)
    expect(node.cascade).toBe(false)
  })
})

describe("TRUNCATE TABLE — PG emission", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("simple form", () => {
    const q = db.compileDDL(truncate("users").build())
    expect(q.sql).toBe('TRUNCATE TABLE "users"')
  })

  it("schema-qualified", () => {
    const q = db.compileDDL(truncate({ name: "events", schema: "audit" }).build())
    expect(q.sql).toBe('TRUNCATE TABLE "audit"."events"')
  })

  it("multi-table list", () => {
    const q = db.compileDDL(truncate(["users", "orders"]).build())
    expect(q.sql).toBe('TRUNCATE TABLE "users", "orders"')
  })

  it("ONLY before the table list", () => {
    const q = db.compileDDL(truncate("events").only().build())
    expect(q.sql).toBe('TRUNCATE TABLE ONLY "events"')
  })

  it("RESTART IDENTITY", () => {
    const q = db.compileDDL(truncate("users").restartIdentity().build())
    expect(q.sql).toBe('TRUNCATE TABLE "users" RESTART IDENTITY')
  })

  it("CASCADE", () => {
    const q = db.compileDDL(truncate("users").cascade().build())
    expect(q.sql).toBe('TRUNCATE TABLE "users" CASCADE')
  })

  it("CONTINUE IDENTITY is the default and emits no keyword", () => {
    const q = db.compileDDL(truncate("users").continueIdentity().build())
    expect(q.sql).toBe('TRUNCATE TABLE "users"')
  })

  it("RESTRICT is the default and emits no keyword", () => {
    const q = db.compileDDL(truncate("users").restrict().build())
    expect(q.sql).toBe('TRUNCATE TABLE "users"')
  })

  it("all modifiers in combination", () => {
    const q = db.compileDDL(
      truncate(["users", "orders"]).only().restartIdentity().cascade().build(),
    )
    expect(q.sql).toBe('TRUNCATE TABLE ONLY "users", "orders" RESTART IDENTITY CASCADE')
  })

  it("via db.schema.truncate", () => {
    const q = db.compileDDL(db.schema.truncate("users").build())
    expect(q.sql).toBe('TRUNCATE TABLE "users"')
  })

  it("via db.schema.truncate with multi-table list", () => {
    const q = db.compileDDL(db.schema.truncate(["a", "b", "c"]).restartIdentity().build())
    expect(q.sql).toBe('TRUNCATE TABLE "a", "b", "c" RESTART IDENTITY')
  })
})

describe("TRUNCATE TABLE — MySQL", () => {
  const db = sumak({ dialect: mysqlDialect(), tables: {} })

  it("simple form works", () => {
    const q = db.compileDDL(truncate("users").build())
    expect(q.sql).toBe("TRUNCATE TABLE `users`")
  })

  it("rejects multi-table list", () => {
    expect(() => db.compileDDL(truncate(["a", "b"]).build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("rejects ONLY", () => {
    expect(() => db.compileDDL(truncate("t").only().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("rejects RESTART IDENTITY", () => {
    expect(() => db.compileDDL(truncate("t").restartIdentity().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("rejects CONTINUE IDENTITY", () => {
    expect(() => db.compileDDL(truncate("t").continueIdentity().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("rejects CASCADE", () => {
    expect(() => db.compileDDL(truncate("t").cascade().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("rejects RESTRICT", () => {
    expect(() => db.compileDDL(truncate("t").restrict().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("TRUNCATE TABLE — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables: {} })

  it("simple form works", () => {
    const q = db.compileDDL(truncate("users").build())
    expect(q.sql).toBe("TRUNCATE TABLE [users]")
  })

  it("schema-qualified simple form", () => {
    const q = db.compileDDL(truncate({ name: "events", schema: "audit" }).build())
    expect(q.sql).toBe("TRUNCATE TABLE [audit].[events]")
  })

  it("rejects multi-table list", () => {
    expect(() => db.compileDDL(truncate(["a", "b"]).build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("rejects ONLY", () => {
    expect(() => db.compileDDL(truncate("t").only().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("rejects RESTART IDENTITY (use DBCC CHECKIDENT)", () => {
    expect(() => db.compileDDL(truncate("t").restartIdentity().build())).toThrow(/DBCC CHECKIDENT/)
  })

  it("rejects CASCADE", () => {
    expect(() => db.compileDDL(truncate("t").cascade().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("TRUNCATE TABLE — SQLite refusal", () => {
  const db = sumak({ dialect: sqliteDialect(), tables: {} })

  it("refuses with a pointer at DELETE FROM", () => {
    expect(() => db.compileDDL(truncate("t").build())).toThrow(/deleteFrom/)
  })

  it("refuses regardless of modifiers", () => {
    expect(() => db.compileDDL(truncate("t").cascade().build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })

  it("refuses the legacy single-table builder too", () => {
    expect(() => db.compileDDL(db.schema.truncateTable("t").build())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

describe("TRUNCATE TABLE — guard against bad combinations", () => {
  const db = sumak({ dialect: pgDialect(), tables: {} })

  it("rejects cascade + restrict set together", () => {
    // The fluent chain replaces them, but a directly-built AST with
    // both set should still fail at print.
    const node = truncate("t").build()
    const bad = { ...node, cascade: true, restrict: true }
    expect(() => db.compileDDL(bad)).toThrow(/mutually exclusive/)
  })

  it("rejects restartIdentity + continueIdentity set together", () => {
    const node = truncate("t").build()
    const bad = { ...node, restartIdentity: true, continueIdentity: true }
    expect(() => db.compileDDL(bad)).toThrow(/mutually exclusive/)
  })
})

describe("TRUNCATE TABLE — back-compat with truncateTable(name)", () => {
  it("still emits the same SQL on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db.compileDDL(db.schema.truncateTable("users").restartIdentity().cascade().build())
    expect(q.sql).toBe('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE')
  })

  it("schema-qualified single-table form works", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const q = db.compileDDL(db.schema.truncateTable("t", "audit").build())
    expect(q.sql).toBe('TRUNCATE TABLE "audit"."t"')
  })
})

describe("TRUNCATE TABLE — PGlite roundtrip", () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
  })

  afterAll(async () => {
    await pg?.close()
  })

  it("inserts rows, truncates, observes count = 0", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    await pg.query(`CREATE TABLE truncate_test (id serial PRIMARY KEY, val text)`)
    await pg.query(`INSERT INTO truncate_test (val) VALUES ('a'), ('b'), ('c')`)

    const before = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM truncate_test`,
    )
    expect(Number(before.rows[0]!.count)).toBe(3)

    await db.executeCompiledNoRows(db.compileDDL(truncate("truncate_test").build()))

    const after = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM truncate_test`,
    )
    expect(Number(after.rows[0]!.count)).toBe(0)

    await pg.query(`DROP TABLE truncate_test`)
  })

  it("RESTART IDENTITY resets the attached sequence", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    await pg.query(`CREATE TABLE truncate_seq_test (id serial PRIMARY KEY, val text)`)
    await pg.query(`INSERT INTO truncate_seq_test (val) VALUES ('a'), ('b'), ('c')`)

    const beforeIds = await pg.query<{ id: number }>(`SELECT id FROM truncate_seq_test ORDER BY id`)
    expect(beforeIds.rows.map((r) => Number(r.id))).toEqual([1, 2, 3])

    await db.executeCompiledNoRows(
      db.compileDDL(truncate("truncate_seq_test").restartIdentity().build()),
    )

    await pg.query(`INSERT INTO truncate_seq_test (val) VALUES ('x')`)
    const afterIds = await pg.query<{ id: number }>(`SELECT id FROM truncate_seq_test ORDER BY id`)
    // Sequence restarted: the inserted row gets id=1 again.
    expect(afterIds.rows.map((r) => Number(r.id))).toEqual([1])

    await pg.query(`DROP TABLE truncate_seq_test`)
  })

  it("multi-table TRUNCATE empties both", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: {} })

    await pg.query(`CREATE TABLE truncate_multi_a (id serial PRIMARY KEY)`)
    await pg.query(`CREATE TABLE truncate_multi_b (id serial PRIMARY KEY)`)
    await pg.query(`INSERT INTO truncate_multi_a DEFAULT VALUES`)
    await pg.query(`INSERT INTO truncate_multi_a DEFAULT VALUES`)
    await pg.query(`INSERT INTO truncate_multi_b DEFAULT VALUES`)

    await db.executeCompiledNoRows(
      db.compileDDL(truncate(["truncate_multi_a", "truncate_multi_b"]).build()),
    )

    const countA = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM truncate_multi_a`,
    )
    const countB = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM truncate_multi_b`,
    )
    expect(Number(countA.rows[0]!.count)).toBe(0)
    expect(Number(countB.rows[0]!.count)).toBe(0)

    await pg.query(`DROP TABLE truncate_multi_a, truncate_multi_b`)
  })
})
