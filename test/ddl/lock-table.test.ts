import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { LockTableBuilder } from "../../src/builder/ddl/lock-table.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { lockTable } from "../../src/index.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

const pg = sumak({ dialect: pgDialect(), tables: {} })
const my = sumak({ dialect: mysqlDialect(), tables: {} })
const sqlite = sumak({ dialect: sqliteDialect(), tables: {} })
const mssql = sumak({ dialect: mssqlDialect(), tables: {} })

describe("LOCK TABLE — builder shape", () => {
  it("lockTable(name) wraps a node with a single table", () => {
    const node = lockTable("orders").build()
    expect(node).toEqual({ type: "lock_table", tables: ["orders"] })
  })

  it("lockTable([...]) wraps a multi-table list", () => {
    const node = lockTable(["orders", "order_lines"]).build()
    expect(node.tables).toEqual(["orders", "order_lines"])
  })

  it("constructor copies the table array (no aliasing)", () => {
    const src = ["a", "b"]
    const node = new LockTableBuilder(src).build()
    src.push("c")
    expect(node.tables).toEqual(["a", "b"])
  })

  it("build() returns an independent copy of the tables array", () => {
    const b = lockTable(["a", "b"])
    const node = b.build()
    node.tables.push("c")
    const fresh = b.build()
    expect(fresh.tables).toEqual(["a", "b"])
  })

  it(".only() flips the flag", () => {
    const node = lockTable("orders").only().build()
    expect(node.only).toBe(true)
  })

  it(".noWait() flips the flag", () => {
    const node = lockTable("orders").noWait().build()
    expect(node.noWait).toBe(true)
  })

  it(".mode(value) sets the mode", () => {
    const node = lockTable("orders").mode("EXCLUSIVE").build()
    expect(node.mode).toBe("EXCLUSIVE")
  })

  it("builders are immutable — fluent clone", () => {
    const a = lockTable("orders")
    const b = a.exclusive()
    const c = b.noWait()
    expect(a.build().mode).toBeUndefined()
    expect(b.build().mode).toBe("EXCLUSIVE")
    expect(b.build().noWait).toBeUndefined()
    expect(c.build().mode).toBe("EXCLUSIVE")
    expect(c.build().noWait).toBe(true)
  })

  it("fluent chain — every option together", () => {
    const node = lockTable(["orders", "order_lines"]).only().shareUpdateExclusive().noWait().build()
    expect(node).toEqual({
      type: "lock_table",
      tables: ["orders", "order_lines"],
      only: true,
      mode: "SHARE UPDATE EXCLUSIVE",
      noWait: true,
    })
  })

  it("mode shortcut methods set the right keyword", () => {
    expect(lockTable("t").accessShare().build().mode).toBe("ACCESS SHARE")
    expect(lockTable("t").rowShare().build().mode).toBe("ROW SHARE")
    expect(lockTable("t").rowExclusive().build().mode).toBe("ROW EXCLUSIVE")
    expect(lockTable("t").shareUpdateExclusive().build().mode).toBe("SHARE UPDATE EXCLUSIVE")
    expect(lockTable("t").share().build().mode).toBe("SHARE")
    expect(lockTable("t").shareRowExclusive().build().mode).toBe("SHARE ROW EXCLUSIVE")
    expect(lockTable("t").exclusive().build().mode).toBe("EXCLUSIVE")
    expect(lockTable("t").accessExclusive().build().mode).toBe("ACCESS EXCLUSIVE")
  })

  it("last mode call wins", () => {
    const node = lockTable("t").share().exclusive().rowExclusive().build()
    expect(node.mode).toBe("ROW EXCLUSIVE")
  })
})

describe("LOCK TABLE — PG emission", () => {
  it("bare statement (no mode, no nowait) — PG defaults to ACCESS EXCLUSIVE", () => {
    const q = pg.compileDDL(lockTable("orders").build())
    expect(q.sql).toBe('LOCK TABLE "orders"')
    expect(q.params).toEqual([])
  })

  it("IN ACCESS SHARE MODE", () => {
    expect(pg.compileDDL(lockTable("orders").accessShare().build()).sql).toBe(
      'LOCK TABLE "orders" IN ACCESS SHARE MODE',
    )
  })

  it("IN ROW SHARE MODE", () => {
    expect(pg.compileDDL(lockTable("orders").rowShare().build()).sql).toBe(
      'LOCK TABLE "orders" IN ROW SHARE MODE',
    )
  })

  it("IN ROW EXCLUSIVE MODE", () => {
    expect(pg.compileDDL(lockTable("orders").rowExclusive().build()).sql).toBe(
      'LOCK TABLE "orders" IN ROW EXCLUSIVE MODE',
    )
  })

  it("IN SHARE UPDATE EXCLUSIVE MODE", () => {
    expect(pg.compileDDL(lockTable("orders").shareUpdateExclusive().build()).sql).toBe(
      'LOCK TABLE "orders" IN SHARE UPDATE EXCLUSIVE MODE',
    )
  })

  it("IN SHARE MODE", () => {
    expect(pg.compileDDL(lockTable("orders").share().build()).sql).toBe(
      'LOCK TABLE "orders" IN SHARE MODE',
    )
  })

  it("IN SHARE ROW EXCLUSIVE MODE", () => {
    expect(pg.compileDDL(lockTable("orders").shareRowExclusive().build()).sql).toBe(
      'LOCK TABLE "orders" IN SHARE ROW EXCLUSIVE MODE',
    )
  })

  it("IN EXCLUSIVE MODE", () => {
    expect(pg.compileDDL(lockTable("orders").exclusive().build()).sql).toBe(
      'LOCK TABLE "orders" IN EXCLUSIVE MODE',
    )
  })

  it("IN ACCESS EXCLUSIVE MODE (explicit)", () => {
    // Same effect as the bare form, but emitted verbatim for audit-trail clarity.
    expect(pg.compileDDL(lockTable("orders").accessExclusive().build()).sql).toBe(
      'LOCK TABLE "orders" IN ACCESS EXCLUSIVE MODE',
    )
  })

  it("ONLY <name>", () => {
    expect(pg.compileDDL(lockTable("orders").only().build()).sql).toBe('LOCK TABLE ONLY "orders"')
  })

  it("NOWAIT", () => {
    expect(pg.compileDDL(lockTable("orders").noWait().build()).sql).toBe(
      'LOCK TABLE "orders" NOWAIT',
    )
  })

  it("ONLY + mode + NOWAIT — all flags", () => {
    expect(pg.compileDDL(lockTable("orders").only().exclusive().noWait().build()).sql).toBe(
      'LOCK TABLE ONLY "orders" IN EXCLUSIVE MODE NOWAIT',
    )
  })

  it("multi-table list (comma-separated)", () => {
    expect(pg.compileDDL(lockTable(["orders", "order_lines"]).build()).sql).toBe(
      'LOCK TABLE "orders", "order_lines"',
    )
  })

  it("multi-table with ONLY + mode + NOWAIT", () => {
    expect(
      pg.compileDDL(lockTable(["orders", "order_lines"]).only().share().noWait().build()).sql,
    ).toBe('LOCK TABLE ONLY "orders", "order_lines" IN SHARE MODE NOWAIT')
  })

  it("identifier quoting — mixed case survives", () => {
    expect(pg.compileDDL(lockTable("MyOrders").exclusive().build()).sql).toBe(
      'LOCK TABLE "MyOrders" IN EXCLUSIVE MODE',
    )
  })

  it("identifier quoting — reserved keyword as table name", () => {
    expect(pg.compileDDL(lockTable("order").build()).sql).toBe('LOCK TABLE "order"')
  })

  it("via db.schema.lockTable(...) — single name", () => {
    const q = pg.compileDDL(pg.schema.lockTable("orders").exclusive().build())
    expect(q.sql).toBe('LOCK TABLE "orders" IN EXCLUSIVE MODE')
  })

  it("via db.schema.lockTable(...) — array", () => {
    const q = pg.compileDDL(pg.schema.lockTable(["orders", "order_lines"]).share().build())
    expect(q.sql).toBe('LOCK TABLE "orders", "order_lines" IN SHARE MODE')
  })

  it("rejects an empty tables list on hand-built AST", () => {
    expect(() =>
      pg.compileDDL({
        type: "lock_table",
        tables: [],
      }),
    ).toThrow(/at least one/i)
  })

  it("rejects an unknown mode keyword on hand-built AST", () => {
    const bad = {
      type: "lock_table",
      tables: ["orders"],
      mode: "GHOST MODE",
    } as unknown as Parameters<typeof pg.compileDDL>[0]
    expect(() => pg.compileDDL(bad)).toThrow(
      /ACCESS SHARE \/ ROW SHARE \/ ROW EXCLUSIVE \/ SHARE UPDATE EXCLUSIVE \/ SHARE \/ SHARE ROW EXCLUSIVE \/ EXCLUSIVE \/ ACCESS EXCLUSIVE/,
    )
  })

  it("LockTableBuilder is constructable directly", () => {
    const node = new LockTableBuilder("orders").exclusive().build()
    expect(node).toEqual({ type: "lock_table", tables: ["orders"], mode: "EXCLUSIVE" })
  })

  it("LockTableBuilder accepts an array constructor arg", () => {
    const node = new LockTableBuilder(["a", "b"]).build()
    expect(node.tables).toEqual(["a", "b"])
  })

  it("db.compile() routes LockTableNode through DDLPrinter", () => {
    const node = pg.schema.lockTable("orders").exclusive().build()
    const q = pg.compile(node)
    expect(q.sql).toBe('LOCK TABLE "orders" IN EXCLUSIVE MODE')
  })
})

describe("LOCK TABLE — non-PG refusal", () => {
  const node = lockTable("orders").exclusive().build()

  it("MySQL refuses", () => {
    expect(() => my.compileDDL(node)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite refuses", () => {
    expect(() => sqlite.compileDDL(node)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL refuses", () => {
    expect(() => mssql.compileDDL(node)).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message names the LOCK TABLE feature", () => {
    try {
      my.compileDDL(node)
      throw new Error("unreachable")
    } catch (e) {
      expect((e as Error).message).toMatch(/LOCK TABLE/)
    }
  })
})

describe("LOCK TABLE — PGlite roundtrip", () => {
  let pgdb: PGlite

  beforeAll(async () => {
    pgdb = new PGlite()
    await pgdb.waitReady
    await pgdb.exec(`CREATE TABLE lock_test (id serial PRIMARY KEY, val text)`)
    await pgdb.exec(`INSERT INTO lock_test (val) VALUES ('a'), ('b'), ('c')`)
  })

  afterAll(async () => {
    await pgdb?.close()
  })

  it("LOCK TABLE inside a transaction works; subsequent SELECT returns rows", async () => {
    // PG only accepts LOCK TABLE inside an explicit transaction; outside
    // one PG returns the error 'LOCK TABLE can only be used in
    // transaction blocks'. The PGlite roundtrip exercises the
    // emitted SQL through the real PG parser + runtime to prove the
    // grammar is exact.
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgdb), tables: {} })

    await pgdb.exec("BEGIN")
    try {
      const lockSql = db.compileDDL(db.schema.lockTable("lock_test").exclusive().build()).sql
      await pgdb.exec(lockSql)

      // Holding the lock; reads we issue ourselves still work.
      const r = await pgdb.query<{ count: string }>(`SELECT count(*)::text AS count FROM lock_test`)
      expect(Number(r.rows[0]!.count)).toBe(3)
    } finally {
      // Release the lock by ending the transaction.
      await pgdb.exec("COMMIT")
    }
  })

  it("LOCK TABLE IN ACCESS SHARE MODE — lightest lock, allows reads", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgdb), tables: {} })

    await pgdb.exec("BEGIN")
    try {
      const sql = db.compileDDL(db.schema.lockTable("lock_test").accessShare().build()).sql
      await pgdb.exec(sql)

      const r = await pgdb.query<{ val: string }>(`SELECT val FROM lock_test ORDER BY id`)
      expect(r.rows.map((row) => row.val)).toEqual(["a", "b", "c"])
    } finally {
      await pgdb.exec("COMMIT")
    }
  })

  it("multi-table LOCK TABLE acquires both at once", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgdb), tables: {} })

    // Build a second table so the multi-table form has something to bite.
    await pgdb.exec(`CREATE TABLE lock_test_partner (id serial PRIMARY KEY, owner text)`)
    await pgdb.exec(`INSERT INTO lock_test_partner (owner) VALUES ('x')`)

    await pgdb.exec("BEGIN")
    try {
      const sql = db.compileDDL(
        db.schema.lockTable(["lock_test", "lock_test_partner"]).share().build(),
      ).sql
      await pgdb.exec(sql)

      const r = await pgdb.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM lock_test_partner`,
      )
      expect(Number(r.rows[0]!.count)).toBe(1)
    } finally {
      await pgdb.exec("COMMIT")
    }

    await pgdb.exec(`DROP TABLE lock_test_partner`)
  })

  it("NOWAIT — emitted SQL parses on the live engine", async () => {
    // NOWAIT only really earns its keep when a *second* connection
    // already holds the conflicting lock — PGlite is single-connection
    // so we can't easily exercise the contention path here. Instead,
    // confirm that the engine accepts the grammar in the no-contention
    // case (where NOWAIT is a no-op).
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgdb), tables: {} })

    await pgdb.exec("BEGIN")
    try {
      const sql = db.compileDDL(db.schema.lockTable("lock_test").exclusive().noWait().build()).sql
      await pgdb.exec(sql)
    } finally {
      await pgdb.exec("COMMIT")
    }
  })

  it("LOCK TABLE outside a transaction surfaces the PG error", async () => {
    // Sanity-check the documented constraint: PG refuses outside an
    // explicit transaction block. We're not testing our printer here,
    // we're documenting the run-time precondition so future-me doesn't
    // get tripped up by it.
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pgdb), tables: {} })
    const sql = db.compileDDL(db.schema.lockTable("lock_test").build()).sql
    await expect(pgdb.exec(sql)).rejects.toThrow(/transaction/i)
  })
})
