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
    // pg_stat_user_indexes confirms the index is wired up and visible to
    // the planner. We don't seed rows + force a scan here because PGlite
    // resets stats per session in unpredictable ways and the planner is
    // free to pick a seq scan on a tiny table — but the row exists with
    // its idx_scan counter (initialized to 0) the moment CREATE INDEX
    // commits, which is the durable invariant.
    const statRows = await db.executeCompiled({
      sql: "SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'idx_ix_posts_active_title'",
      params: [],
    })
    expect(statRows).toHaveLength(1)
    expect(statRows[0]!.indexrelname).toBe("idx_ix_posts_active_title")

    // Insert a mix of live and soft-deleted rows. The partial index
    // covers only the live rows; the soft-deleted ones are excluded by
    // the WHERE predicate at index time, so they don't bloat the index.
    await db.insertInto("ix_posts").values({ id: 1, title: "live-a", deletedAt: null }).exec()
    await db.insertInto("ix_posts").values({ id: 2, title: "live-b", deletedAt: null }).exec()
    await db.insertInto("ix_posts").values({ id: 3, title: "gone", deletedAt: 1700000000 }).exec()

    // Reading a row whose `deletedAt IS NULL` succeeds. We aren't
    // asserting the planner's choice (PGlite is small enough that a seq
    // scan often wins); the point is the index is queryable + correct.
    const live = await db.executeCompiled({
      sql: 'SELECT id FROM "ix_posts" WHERE "deletedAt" IS NULL ORDER BY id',
      params: [],
    })
    expect(live.map((r) => r.id)).toEqual([1, 2])
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
