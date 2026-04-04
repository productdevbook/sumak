import { describe, expect, it } from "vitest"

import { count, filter, sum, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { boolean, integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      dept: text().notNull(),
      age: integer(),
      active: boolean().defaultTo(true),
    },
  },
})

const p = db.printer()

describe("selectCount()", () => {
  it("generates SELECT COUNT(*) FROM table", () => {
    const q = db.selectCount("users").toSQL()
    expect(q.sql).toContain("COUNT(*)")
    expect(q.sql).toContain('"users"')
  })

  it("selectCount with WHERE", () => {
    const q = db
      .selectCount("users")
      .where(({ active }) => active.eq(true))
      .toSQL()
    expect(q.sql).toContain("COUNT(*)")
    expect(q.sql).toContain("WHERE")
  })
})

describe("HAVING with aggregate expressions", () => {
  it("HAVING with count callback", () => {
    const q = db
      .selectFrom("users")
      .select("dept")
      .selectExpr(count(), "cnt")
      .groupBy("dept")
      .having(({ dept }) => dept.eq("engineering"))
      .toSQL()
    expect(q.sql).toContain("HAVING")
    expect(q.sql).toContain("GROUP BY")
  })

  it("HAVING with raw expression", () => {
    const countExpr = count()
    const q = db
      .selectFrom("users")
      .select("dept")
      .selectExpr(countExpr, "cnt")
      .groupBy("dept")
      .having(() => {
        // COUNT(*) > 5
        const node = (countExpr as any).node
        return {
          node: { type: "binary_op", op: ">", left: node, right: { type: "literal", value: 5 } },
        } as any
      })
      .toSQL()
    expect(q.sql).toContain("HAVING")
    expect(q.sql).toContain("COUNT(*)")
    expect(q.sql).toContain("> 5")
  })
})
