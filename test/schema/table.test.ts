import { describe, expect, it, expectTypeOf } from "vitest"

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

    // Required: name, email (notNull, no default)
    expectTypeOf<InsertRow>().toMatchTypeOf<{
      name: string
      email: string
    }>()

    // Optional: id (serial/generated), bio (nullable), active (default), createdAt (default)
    expectTypeOf<{
      id?: number
      bio?: string | null
      active?: boolean
      createdAt?: Date | string
    }>().toMatchTypeOf<InsertRow>()
  })

  it("Updateable makes all columns optional", () => {
    type UpdateRow = Updateable<UsersColumns>

    expectTypeOf<UpdateRow>().toMatchTypeOf<{
      id?: number
      name?: string
      email?: string
      bio?: string | null
      active?: boolean
      createdAt?: Date | string
    }>()
  })
})
