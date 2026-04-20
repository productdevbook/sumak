import { describe, expect, it } from "vitest"

import { avgDistinct, sumDistinct, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    orders: {
      id: serial().primaryKey(),
      amount: integer().notNull(),
      category: text().notNull(),
    },
  },
})

const p = db.printer()

describe("SUM(DISTINCT) and AVG(DISTINCT)", () => {
  it("SUM(DISTINCT expr)", () => {
    const q = db
      .selectFrom("orders")
      .select({ unique_sum: sumDistinct(val(100) as any) })
      .compile(p)
    expect(q.sql).toContain("SUM(DISTINCT")
  })

  it("AVG(DISTINCT expr)", () => {
    const q = db
      .selectFrom("orders")
      .select({ unique_avg: avgDistinct(val(50) as any) })
      .compile(p)
    expect(q.sql).toContain("AVG(DISTINCT")
  })
})
