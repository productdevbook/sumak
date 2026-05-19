import { describe, expect, it } from "vitest"

import { anyValue, val } from "../../src/builder/eb.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  orders: {
    id: serial().primaryKey(),
    customer_id: integer().notNull(),
    city: text(),
  },
}

describe("ANY_VALUE aggregate", () => {
  it("emits ANY_VALUE(expr) on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("orders")
      .select({ city: anyValue(val("Istanbul") as any) })
      .compile(db.printer())
    expect(q.sql).toContain("ANY_VALUE(")
    expect(q.sql).toContain('AS "city"')
  })

  it("emits ANY_VALUE(expr) on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("orders")
      .select({ city: anyValue(val("Istanbul") as any) })
      .compile(db.printer())
    expect(q.sql).toContain("ANY_VALUE(")
    expect(q.sql).toContain("AS `city`")
  })

  it("emits ANY_VALUE(expr) on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("orders")
      .select({ city: anyValue(val("Istanbul") as any) })
      .compile(db.printer())
    expect(q.sql).toContain("ANY_VALUE(")
  })

  it("composes with GROUP BY in a typical functional-dependency query", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("orders")
      .select("customer_id")
      .select({ city: anyValue(val("Istanbul") as any) })
      .groupBy("customer_id")
      .compile(db.printer())
    expect(q.sql).toContain("ANY_VALUE(")
    expect(q.sql).toContain("GROUP BY")
  })

  it("uppercases ANY_VALUE in the emitted SQL (STANDARD_FUNCTIONS path)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("orders")
      .select({ pick: anyValue(val(1) as any) })
      .compile(db.printer())
    expect(q.sql).toMatch(/ANY_VALUE\(/)
    expect(q.sql).not.toMatch(/any_value\(/)
  })

  it("rejects raw JS values — must wrap in val()/typedCol()", () => {
    expect(() => anyValue(42 as any)).toThrow(TypeError)
  })
})
