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
      email: text().notNull(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("Pattern matching operators", () => {
  it("LIKE", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ name }) => name.like("%alice%"))
      .compile(p)
    expect(q.sql).toContain("LIKE")
  })

  it("NOT LIKE", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ name }) => name.notLike("%bob%"))
      .compile(p)
    expect(q.sql).toContain("NOT LIKE")
  })

  it("ILIKE (PG)", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ name }) => name.ilike("%alice%"))
      .compile(p)
    expect(q.sql).toContain("ILIKE")
  })

  it("NOT ILIKE (PG)", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ email }) => email.notIlike("%spam%"))
      .compile(p)
    expect(q.sql).toContain("NOT ILIKE")
  })
})

describe("NOT BETWEEN", () => {
  it("NOT BETWEEN", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.notBetween(18, 65))
      .compile(p)
    expect(q.sql).toContain("NOT BETWEEN")
  })
})
