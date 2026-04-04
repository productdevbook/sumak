import { describe, expect, it } from "vitest"

import { count, countDistinct, filter, sum, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { boolean, integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    orders: {
      id: serial().primaryKey(),
      status: text().notNull(),
      total: integer().notNull(),
      active: boolean().defaultTo(true),
    },
  },
})

const p = db.printer()

describe("Aggregate FILTER (WHERE)", () => {
  it("COUNT(*) FILTER (WHERE ...)", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(filter(count(), val(true) as any), "active_count")
      .compile(p)
    expect(q.sql).toContain("COUNT(*) FILTER (WHERE")
  })

  it("COUNT(DISTINCT) FILTER (WHERE ...)", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(filter(countDistinct(val("test") as any), val(true) as any), "unique_active")
      .compile(p)
    expect(q.sql).toContain("COUNT(DISTINCT")
    expect(q.sql).toContain("FILTER (WHERE")
  })

  it("SUM with FILTER", () => {
    const q = db
      .selectFrom("orders")
      .selectExpr(filter(sum(val(100) as any), val(true) as any), "active_total")
      .compile(p)
    expect(q.sql).toContain("SUM(")
    expect(q.sql).toContain("FILTER (WHERE")
  })

  it("no FILTER when not used", () => {
    const q = db.selectFrom("orders").selectExpr(count(), "total_count").compile(p)
    expect(q.sql).not.toContain("FILTER")
  })
})
