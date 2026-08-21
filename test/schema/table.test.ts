import { describe, expect, it, expectTypeOf } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { boolean, serial, text, timestamp } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import type { InferTable } from "../../src/schema/table.ts"
import type { Insertable, Selectable, Updateable } from "../../src/schema/types.ts"

const usersTable = defineTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  bio: text().nullable(),
  active: boolean().defaultTo(true),
  createdAt: timestamp().defaultTo("now()"),
})

type UsersColumns = InferTable<typeof usersTable>

describe("defineTable", () => {
  it("creates a frozen table definition", () => {
    expect(usersTable.name).toBe("users")
    expect(Object.isFrozen(usersTable)).toBe(true)
  })

  it("has all columns", () => {
    expect(usersTable.columns.id._def.dataType).toBe("serial")
    expect(usersTable.columns.name._def.dataType).toBe("text")
    expect(usersTable.columns.email._def.dataType).toBe("text")
    expect(usersTable.columns.bio._def.dataType).toBe("text")
    expect(usersTable.columns.active._def.dataType).toBe("boolean")
    expect(usersTable.columns.createdAt._def.dataType).toBe("timestamp")
  })
})

describe("Type inference", () => {
  it("Selectable infers correct SELECT types", () => {
    type SelectRow = Selectable<UsersColumns>

    expectTypeOf<SelectRow>().toMatchTypeOf<{
      id: number
      name: string
      email: string
      bio: string | null
      active: boolean
      createdAt: Date
    }>()
  })

  it("Insertable makes generated/default columns optional", () => {
    type InsertRow = Insertable<UsersColumns>

    const full: InsertRow = {
      name: "ada",
      email: "ada@example.com",
      id: 1,
      bio: null,
      active: true,
      createdAt: new Date(),
    }
    const minimal: InsertRow = { name: "ada", email: "ada@example.com" }
    expect(full.name).toBe("ada")
    expect(minimal.email).toBe("ada@example.com")

    // @ts-expect-error name is notNull with no default, so it is required
    const missing: InsertRow = { email: "ada@example.com" }
    expect(missing).toBeTruthy()

    // @ts-expect-error a column keeps its type
    const wrong: InsertRow = { name: 1, email: "ada@example.com" }
    expect(wrong).toBeTruthy()
  })

  it("Insertable also accepts an expression where a value goes", () => {
    // A value with nothing to bind — `NEW.name` inside a trigger function, a
    // declared plpgsql variable — reaches a write as an expression. Without
    // this the caller has to cast, which loses the column's type entirely.
    const row: Insertable<UsersColumns> = {
      name: typedCol<string>("name", "new"),
      email: typedCol<string>("email", "new"),
    }
    expect(row).toBeTruthy()
  })

  it("Updateable makes all columns optional", () => {
    const empty: Updateable<UsersColumns> = {}
    const some: Updateable<UsersColumns> = { name: "ada", active: false }
    expect(empty).toEqual({})
    expect(some.name).toBe("ada")

    // @ts-expect-error a column keeps its type
    const wrong: Updateable<UsersColumns> = { active: "yes" }
    expect(wrong).toBeTruthy()
  })
})
