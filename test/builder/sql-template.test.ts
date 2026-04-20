import { describe, expect, it } from "vitest"

import { val } from "../../src/builder/eb.ts"
import { sql } from "../../src/builder/sql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
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

describe("sql tagged template literal", () => {
  it("plain SQL without interpolation", () => {
    const expr = sql`SELECT 1`
    const node = (expr as any).node
    expect(node.type).toBe("raw")
    expect(node.sql).toBe("SELECT 1")
    expect(node.params).toEqual([])
  })

  it("parameterizes primitive values", () => {
    const expr = sql`SELECT * FROM users WHERE name = ${"Alice"}`
    const node = (expr as any).node
    expect(node.params).toEqual(["Alice"])
    expect(node.sql).toContain("__PARAM_0__")
  })

  it("parameterizes numbers", () => {
    const expr = sql`SELECT * FROM users WHERE id = ${42}`
    const node = (expr as any).node
    expect(node.params).toEqual([42])
  })

  it("handles multiple interpolations", () => {
    const expr = sql`SELECT * FROM users WHERE name = ${"Alice"} AND id = ${1}`
    const node = (expr as any).node
    expect(node.params).toEqual(["Alice", 1])
    expect(node.sql).toContain("__PARAM_0__")
    expect(node.sql).toContain("__PARAM_1__")
  })

  it("inlines literal expressions", () => {
    const expr = sql`SELECT * FROM users WHERE active = ${val(true)}`
    const node = (expr as any).node
    expect(node.sql).toContain("TRUE")
  })

  it("inlines string literal expressions", () => {
    const expr = sql`SELECT * FROM users WHERE name = ${val("Alice")}`
    const node = (expr as any).node
    expect(node.sql).toContain("'Alice'")
  })

  it("inlines numeric literal expressions", () => {
    const expr = sql`SELECT * FROM users WHERE id = ${val(42)}`
    const node = (expr as any).node
    expect(node.sql).toContain("42")
  })

  it("sql.ref creates column reference", () => {
    const expr = sql`SELECT ${sql.ref("id")} FROM users`
    const node = (expr as any).node
    expect(node.sql).toContain('"id"')
  })

  it("sql.ref with table", () => {
    const expr = sql`SELECT ${sql.ref("id", "users")} FROM users`
    const node = (expr as any).node
    expect(node.sql).toContain('"users"."id"')
  })

  it("sql.table creates table reference", () => {
    const expr = sql`SELECT * FROM ${sql.table("users")}`
    const node = (expr as any).node
    expect(node.sql).toContain('"users"')
  })

  it("sql.table with schema", () => {
    const expr = sql`SELECT * FROM ${sql.table("users", "public")}`
    const node = (expr as any).node
    expect(node.sql).toContain('"public"."users"')
  })

  it("sql.unsafe for unsafe SQL", () => {
    const expr = sql`SELECT * FROM ${sql.unsafe("users")} WHERE 1=1`
    const node = (expr as any).node
    expect(node.sql).toContain("users")
  })

  it("sql.lit for literal values", () => {
    const expr = sql`SELECT * FROM users LIMIT ${sql.lit(10)}`
    const node = (expr as any).node
    expect(node.sql).toContain("10")
    expect(node.params).toEqual([])
  })

  it("can be used in selectExpr", () => {
    const q = db
      .selectFrom("users")
      .select({ today: sql`CURRENT_DATE` })
      .compile(p)
    expect(q.sql).toContain("CURRENT_DATE")
    expect(q.sql).toContain('"today"')
  })

  it("escapes single quotes in string literals", () => {
    const expr = sql`SELECT ${val("it's")}`
    const node = (expr as any).node
    expect(node.sql).toContain("'it''s'")
  })
})
