import { describe, expect, it } from "vitest"

import { count, neg, over, val } from "../../src/builder/eb.ts"
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
      score: integer(),
    },
  },
})

const p = db.printer()

describe("Col expression comparisons", () => {
  it("eqExpr", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.eqExpr(val(25) as any))
      .compile(p)
    expect(q.sql).toContain("=")
    expect(q.sql).toContain("25")
  })

  it("neqExpr", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.neqExpr(val(0) as any))
      .compile(p)
    expect(q.sql).toContain("!=")
  })

  it("gtExpr", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.gtExpr(val(18) as any))
      .compile(p)
    expect(q.sql).toContain(">")
  })

  it("ltExpr", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ score }) => score.ltExpr(val(100) as any))
      .compile(p)
    expect(q.sql).toContain("<")
  })
})

describe("neg() unary minus", () => {
  it("negates expression", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(neg(val(42) as any), "negative")
      .compile(p)
    expect(q.sql).toContain("(- 42)")
  })
})

describe("GROUPS frame kind", () => {
  it("GROUPS BETWEEN in window function", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(
        over(count(), (w) =>
          w.orderBy("id").groups({ type: "unbounded_preceding" }, { type: "current_row" }),
        ),
        "cnt",
      )
      .compile(p)
    expect(q.sql).toContain("GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW")
  })
})
