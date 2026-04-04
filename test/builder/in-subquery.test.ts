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
      dept_id: integer(),
    },
    departments: {
      id: serial().primaryKey(),
      name: text().notNull(),
    },
  },
})

const p = db.printer()

describe("IN subquery", () => {
  it("WHERE id IN (SELECT ...)", () => {
    const sub = db.selectFrom("departments").select("id").build()
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ dept_id }) => dept_id.inSubquery(sub))
      .compile(p)
    expect(q.sql).toContain("IN (SELECT")
    expect(q.sql).not.toContain("NOT IN")
  })

  it("WHERE id NOT IN (SELECT ...)", () => {
    const sub = db.selectFrom("departments").select("id").build()
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ dept_id }) => dept_id.notInSubquery(sub))
      .compile(p)
    expect(q.sql).toContain("NOT IN (SELECT")
  })

  it("subquery with WHERE clause", () => {
    const sub = db
      .selectFrom("departments")
      .select("id")
      .where(({ name }) => name.eq("Engineering"))
      .build()
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ dept_id }) => dept_id.inSubquery(sub))
      .compile(p)
    expect(q.sql).toContain("IN (SELECT")
    expect(q.params).toContain("Engineering")
  })
})
