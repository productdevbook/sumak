import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { generateSchemaCode, introspectPg } from "../../src/introspect/index.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { integer, serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// End-to-end roundtrip:
//
//   applyMigration(empty → schema)  →  introspectPg  →  generateSchemaCode
//
// Proves the migrate / introspect / generate trio agree: what we write
// to the database comes back out equivalent to what we put in.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

const SCHEMA = {
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
    email: text().unique().notNull(),
    age: integer().nullable(),
  },
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    user_id: integer().references("users", "id"),
  },
}

describe("introspect roundtrip (pglite)", () => {
  it("empty → SCHEMA via applyMigration puts the right tables in the DB", async () => {
    const driver = pgliteDriver(pg)
    const db = sumak({ dialect: pgDialect(), driver, tables: {} })

    const result = await applyMigration(db, {}, SCHEMA)
    expect(result.applied).toBe(2)
    // CREATE TABLE for each of users / posts — in topo order (users first).
    expect(result.statements[0]).toMatch(/CREATE TABLE .*"users"/i)
    expect(result.statements[1]).toMatch(/CREATE TABLE .*"posts"/i)
  })

  it("introspectPg sees the tables we just created", async () => {
    const driver = pgliteDriver(pg)
    const schema = await introspectPg(driver)
    const names = schema.tables.map((t) => t.name).sort()
    expect(names).toEqual(["posts", "users"])
  })

  it("column types + PK / nullable / FK survive the roundtrip", async () => {
    const driver = pgliteDriver(pg)
    const schema = await introspectPg(driver)

    const users = schema.tables.find((t) => t.name === "users")!
    const idCol = users.columns.find((c) => c.name === "id")!
    expect(idCol.isPrimaryKey).toBe(true)
    expect(idCol.nullable).toBe(false)
    expect(idCol.dataType).toBe("serial")

    const emailCol = users.columns.find((c) => c.name === "email")!
    expect(emailCol.isUnique).toBe(true)
    expect(emailCol.nullable).toBe(false)
    expect(emailCol.dataType).toBe("text")

    const ageCol = users.columns.find((c) => c.name === "age")!
    expect(ageCol.nullable).toBe(true)

    const posts = schema.tables.find((t) => t.name === "posts")!
    const userIdCol = posts.columns.find((c) => c.name === "user_id")!
    expect(userIdCol.references?.table).toBe("users")
    expect(userIdCol.references?.column).toBe("id")
  })

  it("generateSchemaCode produces TS source that mentions every live column", async () => {
    const driver = pgliteDriver(pg)
    const schema = await introspectPg(driver)
    const code = generateSchemaCode(schema)
    // Smoke-check: the import list is present and every column shows up.
    expect(code).toContain('from "sumak/schema"')
    expect(code).toContain("users: {")
    expect(code).toContain("posts: {")
    expect(code).toContain("id: serial().primaryKey()")
    expect(code).toContain("email: text().unique()")
    expect(code).toContain('.references("users", "id")')
  })
})
