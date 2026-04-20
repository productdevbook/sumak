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

describe("onConflictDoUpdateSet (plain object)", () => {
  it("generates parameterized SET from object", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "a@b.com" })
      .onConflict({ columns: ["email"], do: { update: { name: "Alice Updated" } } })
      .compile(p)
    expect(q.sql).toContain("ON CONFLICT")
    expect(q.sql).toContain("DO UPDATE SET")
    expect(q.params).toContain("Alice Updated")
  })

  it("multiple SET columns", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "a@b.com" })
      .onConflict({ columns: ["email"], do: { update: { name: "Bob", email: "b@b.com" } } })
      .compile(p)
    expect(q.sql).toContain("DO UPDATE SET")
    expect(q.params).toContain("Bob")
    expect(q.params).toContain("b@b.com")
  })

  it("Expression-based still works", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "a@b.com" })
      .onConflict({
        columns: ["email"],
        do: { update: [{ column: "name", value: val("Updated") }] },
      })
      .compile(p)
    expect(q.sql).toContain("DO UPDATE SET")
  })

  it(".onConflict({ do: { update: {} } }) throws — no empty SET allowed", () => {
    expect(() =>
      db
        .insertInto("users")
        .values({ name: "a", email: "x@x.com" })
        .onConflict({ columns: ["id"], do: { update: {} } })
        .toSQL(),
    ).toThrow(/DO UPDATE requires at least one column/i)
  })

  it(".onConflict() throws when both columns and constraint are provided", () => {
    expect(() =>
      db
        .insertInto("users")
        .values({ name: "a", email: "x@x.com" })
        .onConflict({ columns: ["id"], constraint: "x", do: "nothing" } as any),
    ).toThrow(/exactly one/i)
  })

  it(".onConflict() throws when neither columns nor constraint is provided", () => {
    expect(() =>
      db
        .insertInto("users")
        .values({ name: "a", email: "x@x.com" })
        .onConflict({ do: "nothing" } as any),
    ).toThrow(/exactly one/i)
  })
})
