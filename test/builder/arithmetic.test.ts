import { describe, expect, it } from "vitest"

import { add, div, mod, mul, sub, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    orders: {
      id: serial().primaryKey(),
      price: integer().notNull(),
      qty: integer().notNull(),
    },
  },
})

const p = db.printer()

describe("Arithmetic operators", () => {
  it("add: a + b", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(add(val(10) as any, val(5) as any), "total")
      .compile(p)
    expect(q.sql).toContain("(10 + 5)")
  })

  it("sub: a - b", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(sub(val(10) as any, val(3) as any), "diff")
      .compile(p)
    expect(q.sql).toContain("(10 - 3)")
  })

  it("mul: a * b", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(mul(val(4) as any, val(5) as any), "product")
      .compile(p)
    expect(q.sql).toContain("(4 * 5)")
  })

  it("div: a / b", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(div(val(10) as any, val(2) as any), "quotient")
      .compile(p)
    expect(q.sql).toContain("(10 / 2)")
  })

  it("mod: a % b", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(mod(val(10) as any, val(3) as any), "remainder")
      .compile(p)
    expect(q.sql).toContain("(10 % 3)")
  })

  it("nested arithmetic", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(add(mul(val(2) as any, val(3) as any), val(1) as any), "result")
      .compile(p)
    expect(q.sql).toContain("((2 * 3) + 1)")
  })
})
