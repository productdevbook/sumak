import { describe, expect, it } from "vitest"

import { Col } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    products: {
      id: serial().primaryKey(),
      name: text().notNull(),
      price: integer().notNull(),
      cost: integer().notNull(),
    },
  },
})

const p = db.printer()

describe("Column-to-column comparisons", () => {
  it("eqCol", () => {
    const a = new Col<number>("price")
    const b = new Col<number>("cost")
    const q = db
      .selectFrom("products")
      .select("id")
      .where(() => a.eqCol(b))
      .compile(p)
    expect(q.sql).toContain("=")
  })

  it("neqCol", () => {
    const a = new Col<number>("price")
    const b = new Col<number>("cost")
    const q = db
      .selectFrom("products")
      .select("id")
      .where(() => a.neqCol(b))
      .compile(p)
    expect(q.sql).toContain("!=")
  })

  it("gtCol", () => {
    const a = new Col<number>("price")
    const b = new Col<number>("cost")
    const q = db
      .selectFrom("products")
      .select("id")
      .where(() => a.gtCol(b))
      .compile(p)
    expect(q.sql).toContain(">")
  })

  it("ltCol", () => {
    const a = new Col<number>("price")
    const b = new Col<number>("cost")
    const q = db
      .selectFrom("products")
      .select("id")
      .where(() => a.ltCol(b))
      .compile(p)
    expect(q.sql).toContain("<")
  })

  it("gteCol", () => {
    const a = new Col<number>("price")
    const b = new Col<number>("cost")
    const q = db
      .selectFrom("products")
      .select("id")
      .where(() => a.gteCol(b))
      .compile(p)
    expect(q.sql).toContain(">=")
  })

  it("lteCol", () => {
    const a = new Col<number>("price")
    const b = new Col<number>("cost")
    const q = db
      .selectFrom("products")
      .select("id")
      .where(() => a.lteCol(b))
      .compile(p)
    expect(q.sql).toContain("<=")
  })
})

describe("Multi-row insert (valuesMany)", () => {
  it("inserts multiple rows", () => {
    const q = db
      .insertInto("products")
      .valuesMany([
        { name: "A", price: 10, cost: 5 },
        { name: "B", price: 20, cost: 10 },
        { name: "C", price: 30, cost: 15 },
      ])
      .compile(p)
    expect(q.sql).toContain("VALUES")
    expect(q.params).toHaveLength(9)
  })

  it("single row via valuesMany", () => {
    const q = db
      .insertInto("products")
      .valuesMany([{ name: "A", price: 10, cost: 5 }])
      .compile(p)
    expect(q.params).toHaveLength(3)
  })
})
