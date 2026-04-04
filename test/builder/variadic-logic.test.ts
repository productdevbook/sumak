import { describe, expect, it } from "vitest"

import { and, or, rawExpr, val } from "../../src/builder/eb.ts"
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

describe("Variadic and()", () => {
  it("two args (backward compat)", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age, score }) => and(age.gt(18), score.gt(50)))
      .compile(p)
    expect(q.sql).toContain("AND")
  })

  it("three args", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ id, age, score }) => and(id.gt(0), age.gt(18), score.gt(50)))
      .compile(p)
    // Should produce (id > 0 AND age > 18) AND score > 50
    const andCount = (q.sql.match(/AND/g) || []).length
    expect(andCount).toBe(2)
  })

  it("single arg returns itself", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => and(age.gt(18)))
      .compile(p)
    expect(q.sql).toContain(">")
    expect(q.sql).not.toContain("AND")
  })
})

describe("Variadic or()", () => {
  it("two args (backward compat)", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ name, age }) => or(name.eq("Alice"), age.gt(30)))
      .compile(p)
    expect(q.sql).toContain("OR")
  })

  it("three args", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ id, name, age }) => or(id.eq(1), name.eq("Bob"), age.gt(65)))
      .compile(p)
    const orCount = (q.sql.match(/OR/g) || []).length
    expect(orCount).toBe(2)
  })
})

describe("gteExpr / lteExpr", () => {
  it("gteExpr", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.gteExpr(val(18) as any))
      .compile(p)
    expect(q.sql).toContain(">=")
  })

  it("lteExpr", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.lteExpr(val(65) as any))
      .compile(p)
    expect(q.sql).toContain("<=")
  })
})

describe("rawExpr()", () => {
  it("raw SQL in WHERE", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(() => rawExpr<boolean>("age > 18"))
      .compile(p)
    expect(q.sql).toContain("age > 18")
  })

  it("raw SQL in selectExpr", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(rawExpr<number>("EXTRACT(YEAR FROM created_at)"), "year")
      .compile(p)
    expect(q.sql).toContain("EXTRACT(YEAR FROM created_at)")
    expect(q.sql).toContain('"year"')
  })

  it("raw SQL with params", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(() => rawExpr<boolean>("age > $1", [18]))
      .compile(p)
    expect(q.sql).toContain("age > $1")
    expect(q.params).toContain(18)
  })
})
