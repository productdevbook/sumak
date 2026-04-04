import { describe, expect, it } from "vitest"

import { pgDialect } from "../src/dialect/pg.ts"
import { SoftDeletePlugin } from "../src/plugin/soft-delete.ts"
import { WithSchemaPlugin } from "../src/plugin/with-schema.ts"
import { boolean, integer, serial, text, timestamp } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      active: boolean().defaultTo(true),
      createdAt: timestamp().defaultTo("now()"),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      body: text().nullable(),
      userId: integer().references("users", "id"),
    },
  },
})

describe("sumak() — clean API", () => {
  it("selectFrom infers table names", () => {
    expect(db.selectFrom("users").compile(db.printer()).sql).toBe('SELECT * FROM "users"')
  })

  it("select narrows columns", () => {
    const q = db.selectFrom("users").select("id", "name")
    expect(q.compile(db.printer()).sql).toBe('SELECT "id", "name" FROM "users"')
  })

  it("where with callback", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ id }) => id.eq(42))
    const result = q.compile(db.printer())
    expect(result.sql).toContain("WHERE")
    expect(result.params).toEqual([42])
  })

  it("insertInto with type-safe values", () => {
    const q = db.insertInto("users").values({ name: "Alice", email: "alice@example.com" })
    const result = q.compile(db.printer())
    expect(result.sql).toContain("INSERT INTO")
    expect(result.params).toContain("Alice")
  })

  it("insertInto posts", () => {
    const q = db.insertInto("posts").values({ title: "Hello World", userId: 1 })
    const result = q.compile(db.printer())
    expect(result.sql).toContain('"posts"')
    expect(result.params).toContain("Hello World")
  })

  it("update with callback where", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
    const result = q.compile(db.printer())
    expect(result.sql).toContain("UPDATE")
    expect(result.sql).toContain("SET")
  })

  it("deleteFrom with callback where", () => {
    const q = db.deleteFrom("users").where(({ id }) => id.eq(1))
    const result = q.compile(db.printer())
    expect(result.sql).toContain("DELETE FROM")
    expect(result.params).toEqual([1])
  })

  it("compile runs plugin pipeline", () => {
    const dbP = sumak({
      dialect: pgDialect(),
      plugins: [new WithSchemaPlugin("public")],
      tables: { users: { id: serial(), name: text().notNull() } },
    })
    const result = dbP.compile(dbP.selectFrom("users").build())
    expect(result.sql).toContain('"public"."users"')
  })

  it("compile runs multiple plugins", () => {
    const dbP = sumak({
      dialect: pgDialect(),
      plugins: [new WithSchemaPlugin("app"), new SoftDeletePlugin({ tables: ["users"] })],
      tables: { users: { id: serial(), name: text().notNull() } },
    })
    const result = dbP.compile(dbP.selectFrom("users").build())
    expect(result.sql).toContain('"app"."users"')
    expect(result.sql).toContain("IS NULL")
  })
})
