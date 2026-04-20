import { describe, expect, it } from "vitest"

import { coalesce, count, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      nick: text(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("Variadic COALESCE", () => {
  it("two args (backward compat)", () => {
    const q = db
      .selectFrom("users")
      .select({ v: coalesce(val(null) as any, val("default")) })
      .compile(p)
    expect(q.sql).toContain("COALESCE(")
    expect(q.sql).toContain("'default'")
  })

  it("three args", () => {
    const q = db
      .selectFrom("users")
      .select({ v: coalesce(val(null) as any, val(null) as any, val("fallback")) })
      .compile(p)
    expect(q.sql).toContain("COALESCE(NULL, NULL, 'fallback')")
  })

  it("four args", () => {
    const q = db
      .selectFrom("users")
      .select({
        v: coalesce(val(null) as any, val(null) as any, val(null) as any, val(0) as any),
      })
      .compile(p)
    expect(q.sql).toContain("COALESCE(NULL, NULL, NULL, 0)")
  })
})

describe("IS DISTINCT FROM / IS NOT DISTINCT FROM", () => {
  it("IS DISTINCT FROM", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.distinctFrom(null as any))
      .compile(p)
    expect(q.sql).toContain("IS DISTINCT FROM")
  })

  it("IS NOT DISTINCT FROM", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.distinctFrom(25, { negate: true }))
      .compile(p)
    expect(q.sql).toContain("IS NOT DISTINCT FROM")
  })
})

describe("$call() pipe method", () => {
  it("pipes builder through function", () => {
    const addPagination = (qb: any) => qb.limit(10).offset(20)
    const q = db.selectFrom("users").select("id", "name").$call(addPagination).compile(p)
    expect(q.sql).toContain("LIMIT")
    expect(q.sql).toContain("OFFSET")
  })

  it("reusable query fragment", () => {
    const onlyActive = (qb: any) => qb.where(({ age }: any) => age.gt(0))
    const q = db.selectFrom("users").select("id").$call(onlyActive).compile(p)
    expect(q.sql).toContain("WHERE")
  })
})

describe("selectExprs — multiple expressions", () => {
  it("adds multiple aliased expressions", () => {
    const q = db
      .selectFrom("users")
      .select({
        total: count(),
        greeting: val("hello"),
      })
      .compile(p)
    expect(q.sql).toContain('"total"')
    expect(q.sql).toContain('"greeting"')
    expect(q.sql).toContain("COUNT(*)")
  })
})
