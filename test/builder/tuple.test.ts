import { describe, expect, it } from "vitest"

import { tuple, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("Tuple comparisons", () => {
  it("tuple as expression", () => {
    const q = db
      .selectFrom("users")
      .selectAll()
      .selectExpr(tuple(val(1), val(2)), "pair")
      .compile(p)
    expect(q.sql).toContain("(1, 2)")
  })

  it("tuple in WHERE equality", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ id, age }) => {
        const left = tuple(id.toExpr(), age.toExpr())
        const right = tuple(val(1), val(25))
        return {
          node: {
            type: "binary_op",
            op: "=",
            left: (left as any).node,
            right: (right as any).node,
          },
        } as any
      })
      .compile(p)
    expect(q.sql).toContain("(")
    expect(q.sql).toContain("=")
  })

  it("single element tuple", () => {
    const q = db
      .selectFrom("users")
      .selectAll()
      .selectExpr(tuple(val(42)), "single")
      .compile(p)
    expect(q.sql).toContain("(42)")
  })

  it("three element tuple", () => {
    const q = db
      .selectFrom("users")
      .selectAll()
      .selectExpr(tuple(val(1), val("a"), val(true)), "triple")
      .compile(p)
    expect(q.sql).toContain("(1, 'a', TRUE)")
  })
})
