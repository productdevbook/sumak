import { describe, expect, it } from "vitest"

import { val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
    },
  },
})

const p = db.printer()

describe("ON CONFLICT ON CONSTRAINT", () => {
  it("DO NOTHING with constraint name", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "a@b.com" })
      .onConflictConstraintDoNothing("users_email_key")
      .compile(p)
    expect(q.sql).toContain("ON CONFLICT ON CONSTRAINT")
    expect(q.sql).toContain('"users_email_key"')
    expect(q.sql).toContain("DO NOTHING")
  })

  it("DO UPDATE with constraint name", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "a@b.com" })
      .onConflictConstraintDoUpdate("users_email_key", [
        { column: "name", value: val("Alice Updated") },
      ])
      .compile(p)
    expect(q.sql).toContain("ON CONFLICT ON CONSTRAINT")
    expect(q.sql).toContain("DO UPDATE SET")
  })

  it("column-based ON CONFLICT still works", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "a@b.com" })
      .onConflictDoNothing("email")
      .compile(p)
    expect(q.sql).toContain("ON CONFLICT")
    expect(q.sql).not.toContain("ON CONSTRAINT")
    expect(q.sql).toContain("DO NOTHING")
  })
})
