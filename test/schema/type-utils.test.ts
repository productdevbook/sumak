import { describe, expectTypeOf, it } from "vitest"

import { boolean, serial, text, timestamp } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import type { InferTable } from "../../src/schema/table.ts"
import type {
  AnyColumn,
  ColumnName,
  FullSelectModel,
  Nullable,
  QualifiedColumn,
  ResolveColumnType,
  SelectResult,
  TableName,
} from "../../src/schema/type-utils.ts"

// Test schema
const users = defineTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  active: boolean().defaultTo(true),
})

const posts = defineTable("posts", {
  id: serial().primaryKey(),
  title: text().notNull(),
  userId: serial(),
  createdAt: timestamp().defaultTo("now()"),
})

type DB = {
  users: InferTable<typeof users>
  posts: InferTable<typeof posts>
}

describe("Type utility types", () => {
  it("TableName extracts table names", () => {
    expectTypeOf<TableName<DB>>().toEqualTypeOf<"users" | "posts">()
  })

  it("ColumnName extracts column names for a table", () => {
    expectTypeOf<ColumnName<DB, "users">>().toEqualTypeOf<"id" | "name" | "email" | "active">()
  })

  it("QualifiedColumn creates table.column strings", () => {
    type Q = QualifiedColumn<DB, "users">
    expectTypeOf<"users.id">().toMatchTypeOf<Q>()
    expectTypeOf<"users.name">().toMatchTypeOf<Q>()
  })

  it("AnyColumn includes both qualified and unqualified", () => {
    type A = AnyColumn<DB, "users">
    expectTypeOf<"id">().toMatchTypeOf<A>()
    expectTypeOf<"users.id">().toMatchTypeOf<A>()
  })

  it("ResolveColumnType resolves unqualified column", () => {
    type R = ResolveColumnType<DB, "users", "name">
    expectTypeOf<R>().toEqualTypeOf<string>()
  })

  it("ResolveColumnType resolves qualified column", () => {
    type R = ResolveColumnType<DB, "users" | "posts", "users.id">
    expectTypeOf<R>().toEqualTypeOf<number>()
  })

  it("Nullable makes all properties nullable", () => {
    type N = Nullable<{ a: string; b: number }>
    expectTypeOf<N>().toEqualTypeOf<{ a: string | null; b: number | null }>()
  })

  it("FullSelectModel extracts select types", () => {
    type M = FullSelectModel<DB, "users">
    expectTypeOf<M>().toMatchTypeOf<{
      id: number
      name: string
      email: string
      active: boolean
    }>()
  })

  it("SelectResult builds result from selected columns", () => {
    type R = SelectResult<DB, "users", "id" | "name">
    expectTypeOf<R>().toMatchTypeOf<{
      id: number
      name: string
    }>()
  })
})
