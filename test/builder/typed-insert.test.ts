import { describe, expect, it } from "vitest"
import { sumak } from "../../src/sumak.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { boolean, serial, text } from "../../src/schema/column.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      active: boolean().defaultTo(true),
    },
  },
})

const printer = db.printer()

describe("TypedInsertBuilder", () => {
  it("inserts a row with required columns", () => {
    const q = db.insertInto("users").values({ name: "Alice", email: "alice@example.com" })
    const result = q.compile(printer)
    expect(result.sql).toContain("INSERT INTO")
    expect(result.sql).toContain('"users"')
    expect(result.params.length).toBeGreaterThan(0)
  })

  it("inserts a row with optional columns", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Bob", email: "bob@example.com", active: false })
    const result = q.compile(printer)
    expect(result.params).toContain("Bob")
    expect(result.params).toContain(false)
  })

  it("inserts with RETURNING *", () => {
    const q = db.insertInto("users").values({ name: "Alice", email: "a@b.com" }).returningAll()
    expect(q.compile(printer).sql).toContain("RETURNING *")
  })

  it("inserts with RETURNING specific columns", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "a@b.com" })
      .returning("id", "name")
    const result = q.compile(printer)
    expect(result.sql).toContain("RETURNING")
    expect(result.sql).toContain('"id"')
  })

  it("inserts with ON CONFLICT DO NOTHING", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "a@b.com" })
      .onConflictDoNothing("email")
    expect(q.compile(printer).sql).toContain("DO NOTHING")
  })
})
