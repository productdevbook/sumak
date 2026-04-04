import { describe, expect, it } from "vitest"

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

describe("Clear methods", () => {
  it("clearWhere removes WHERE", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ id }) => id.eq(1))
      .clearWhere()
      .compile(p)
    expect(q.sql).not.toContain("WHERE")
  })

  it("clearOrderBy removes ORDER BY", () => {
    const q = db.selectFrom("users").select("id", "name").orderBy("name").clearOrderBy().compile(p)
    expect(q.sql).not.toContain("ORDER BY")
  })

  it("clearLimit removes LIMIT", () => {
    const q = db.selectFrom("users").select("id").limit(10).clearLimit().compile(p)
    expect(q.sql).not.toContain("LIMIT")
  })

  it("clearOffset removes OFFSET", () => {
    const q = db.selectFrom("users").select("id").offset(20).clearOffset().compile(p)
    expect(q.sql).not.toContain("OFFSET")
  })

  it("clearGroupBy removes GROUP BY", () => {
    const q = db.selectFrom("users").selectAll().groupBy("name").clearGroupBy().compile(p)
    expect(q.sql).not.toContain("GROUP BY")
  })

  it("clearHaving removes HAVING", () => {
    const q = db
      .selectFrom("users")
      .selectAll()
      .groupBy("name")
      .having(({ age }) => age.gt(0))
      .clearHaving()
      .compile(p)
    expect(q.sql).not.toContain("HAVING")
  })

  it("clearSelect resets columns (becomes SELECT *)", () => {
    const q = db.selectFrom("users").select("id", "name").clearSelect().compile(p)
    expect(q.sql).toContain("SELECT *")
  })

  it("clear then re-add works", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .orderBy("name")
      .clearOrderBy()
      .orderBy("id", "DESC")
      .compile(p)
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("DESC")
    // ORDER BY should only have "id", not "name"
    expect(q.sql).not.toContain('ORDER BY "name"')
  })
})
