import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { integer, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG proof that schema-declared indexes hit the engine.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

describe("table indexes — pglite roundtrip", () => {
  it("creates and enforces a UNIQUE index", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      ix_users: defineTable(
        "ix_users",
        { id: integer().primaryKey(), email: text().notNull() },
        { indexes: [{ name: "uq_ix_users_email", columns: ["email"], unique: true }] },
      ),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    await db.insertInto("ix_users").values({ id: 1, email: "a@example.com" }).exec()
    await expect(
      db.insertInto("ix_users").values({ id: 2, email: "a@example.com" }).exec(),
    ).rejects.toThrow(/duplicate|unique|uq_ix_users_email/i)
  })

  it("creates a partial index that only matches matching rows", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      ix_posts: defineTable(
        "ix_posts",
        {
          id: integer().primaryKey(),
          title: text().notNull(),
          deletedAt: integer().nullable(),
        },
        {
          indexes: [
            {
              name: "idx_ix_posts_active_title",
              columns: ["title"],
              where: '"deletedAt" IS NULL',
            },
          ],
        },
      ),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    // The index is present in pg_indexes with the partial predicate.
    const rows = await db.executeCompiled({
      sql: "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_ix_posts_active_title'",
      params: [],
    })
    expect(rows).toHaveLength(1)
    expect(String(rows[0]!.indexdef)).toMatch(/WHERE/i)
  })

  it("can DROP an index via a follow-up migration", async () => {
    const driver = pgliteDriver(pg)
    const before = {
      ix_tags: defineTable(
        "ix_tags",
        { id: integer().primaryKey(), name: text().notNull() },
        { indexes: [{ name: "idx_ix_tags_name", columns: ["name"] }] },
      ),
    }
    const after = {
      ix_tags: defineTable("ix_tags", { id: integer().primaryKey(), name: text().notNull() }),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: after })
    await applyMigration(db, {}, before)

    const presentBefore = await db.executeCompiled({
      sql: "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_ix_tags_name'",
      params: [],
    })
    expect(presentBefore).toHaveLength(1)

    await applyMigration(db, before, after, { allowDestructive: true })

    const presentAfter = await db.executeCompiled({
      sql: "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_ix_tags_name'",
      params: [],
    })
    expect(presentAfter).toHaveLength(0)
  })
})
