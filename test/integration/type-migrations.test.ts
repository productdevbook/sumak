import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { sql } from "../../src/builder/sql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

describe("ALTER COLUMN TYPE + USING — pglite", () => {
  it("text → int with USING age::int converts existing rows", async () => {
    const driver = pgliteDriver(pg)
    const before = {
      tm_users: { id: serial().primaryKey(), age: text().notNull() },
    }
    const after = {
      tm_users: { id: serial().primaryKey(), age: integer().notNull() },
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: after })
    await applyMigration(db, {}, before)
    await db
      .insertInto("tm_users")
      .values({ id: 1, age: "42" } as any)
      .exec()

    await applyMigration(db, before, after, {
      typeMigrations: { "tm_users.age": { using: sql`age::int` } },
    })

    const rows = await db.selectFrom("tm_users").selectAll().many()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.age).toBe(42) // now an integer, not the string "42"
  })
})
