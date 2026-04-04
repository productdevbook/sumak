import { describe, expect, it } from "vitest"

import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
    },
  },
})

const p = db.printer()

describe("EXPLAIN", () => {
  it("basic EXPLAIN", () => {
    const q = db.selectFrom("users").select("id", "name").explain().compile(p)
    expect(q.sql).toMatch(/^EXPLAIN SELECT/)
  })

  it("EXPLAIN ANALYZE", () => {
    const q = db.selectFrom("users").select("id", "name").explain({ analyze: true }).compile(p)
    expect(q.sql).toMatch(/^EXPLAIN ANALYZE SELECT/)
  })

  it("EXPLAIN with FORMAT JSON", () => {
    const q = db.selectFrom("users").select("id", "name").explain({ format: "JSON" }).compile(p)
    expect(q.sql).toContain("EXPLAIN (FORMAT JSON)")
  })

  it("EXPLAIN ANALYZE with FORMAT", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .explain({ analyze: true, format: "YAML" })
      .compile(p)
    expect(q.sql).toContain("EXPLAIN ANALYZE (FORMAT YAML)")
  })

  it("EXPLAIN in MySQL", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    const q = mydb.selectFrom("users").select("id").explain().compile(mydb.printer())
    expect(q.sql).toMatch(/^EXPLAIN SELECT/)
  })

  it("EXPLAIN in SQLite", () => {
    const sldb = sumak({
      dialect: sqliteDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    const q = sldb.selectFrom("users").select("id").explain().compile(sldb.printer())
    expect(q.sql).toMatch(/^EXPLAIN SELECT/)
  })

  it("EXPLAIN preserves WHERE clause", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ id }) => id.eq(1))
      .explain()
      .compile(p)
    expect(q.sql).toContain("EXPLAIN")
    expect(q.sql).toContain("WHERE")
  })

  it("explain().build() returns ExplainNode", () => {
    const node = db.selectFrom("users").select("id").explain().build()
    expect(node.type).toBe("explain")
    expect(node.statement.type).toBe("select")
  })

  it("EXPLAIN INSERT", () => {
    const q = db.insertInto("users").values({ name: "Alice" }).explain().compile(p)
    expect(q.sql).toMatch(/^EXPLAIN INSERT/)
  })

  it("EXPLAIN UPDATE", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .explain()
      .compile(p)
    expect(q.sql).toMatch(/^EXPLAIN UPDATE/)
  })

  it("EXPLAIN DELETE", () => {
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .explain()
      .compile(p)
    expect(q.sql).toMatch(/^EXPLAIN DELETE/)
  })

  it("EXPLAIN ANALYZE on INSERT", () => {
    const q = db.insertInto("users").values({ name: "Alice" }).explain({ analyze: true }).compile(p)
    expect(q.sql).toMatch(/^EXPLAIN ANALYZE INSERT/)
  })
})
