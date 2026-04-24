import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import type { BetterSqlite3Database } from "../../src/drivers/better-sqlite3.ts"
import { betterSqlite3Driver } from "../../src/drivers/better-sqlite3.ts"

// better-sqlite3 ships without types; import it dynamically so TS
// doesn't need a declaration file. The native class fits
// `BetterSqlite3Database` by shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = (await import("better-sqlite3" as any)).default as new (
  path: string,
) => BetterSqlite3Database & { close(): void; pragma(p: string): void }
import { introspectSqlite } from "../../src/introspect/sqlite.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { integer, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import { sumak } from "../../src/sumak.ts"

// End-to-end: apply a sumak schema against an in-memory SQLite, read
// the catalogs back with `introspectSqlite`, and check the recovered
// shape matches the input. Proves composite PK/UQ, CHECK bodies, and
// named indexes round-trip through PRAGMAs + sqlite_master.sql parsing.

let db: BetterSqlite3Database & { close(): void; pragma(p: string): void }

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
})

afterEach(() => {
  db.close()
})

describe("introspectSqlite — recovers table-level constraints and indexes", () => {
  it("reads a composite PK", async () => {
    const driver = betterSqlite3Driver(db)
    const schema = {
      ix_order_items: defineTable(
        "ix_order_items",
        {
          orderId: integer().notNull(),
          sku: text().notNull(),
          qty: integer().notNull(),
        },
        { constraints: { primaryKey: ["orderId", "sku"] } },
      ),
    }
    const s = sumak({ dialect: sqliteDialect(), driver, tables: schema })
    await applyMigration(s, {}, schema)

    const introspected = await introspectSqlite(driver)
    const t = introspected.tables.find((x) => x.name === "ix_order_items")!
    expect([...(t.constraints?.primaryKey?.columns ?? [])]).toEqual(["orderId", "sku"])
  })

  it("reads a named composite UNIQUE", async () => {
    const driver = betterSqlite3Driver(db)
    const schema = {
      ix_members: defineTable(
        "ix_members",
        { orgId: integer().notNull(), userId: integer().notNull() },
        {
          constraints: {
            uniques: [{ name: "uq_ix_members", columns: ["orgId", "userId"] }],
          },
        },
      ),
    }
    const s = sumak({ dialect: sqliteDialect(), driver, tables: schema })
    await applyMigration(s, {}, schema)

    const introspected = await introspectSqlite(driver)
    const t = introspected.tables.find((x) => x.name === "ix_members")!
    expect([...(t.constraints?.uniques?.[0]?.columns ?? [])]).toEqual(["orgId", "userId"])
  })

  it("reads a CHECK with a recognisable body from sqlite_master.sql", async () => {
    const driver = betterSqlite3Driver(db)
    const schema = {
      ix_products: defineTable(
        "ix_products",
        { id: integer().primaryKey(), price: integer().notNull() },
        { constraints: { checks: [{ name: "ck_ix_price_pos", expression: "price > 0" }] } },
      ),
    }
    const s = sumak({ dialect: sqliteDialect(), driver, tables: schema })
    await applyMigration(s, {}, schema)

    const introspected = await introspectSqlite(driver)
    const t = introspected.tables.find((x) => x.name === "ix_products")!
    const c = t.constraints?.checks?.[0]
    expect(c).toBeDefined()
    expect(c!.expression).toMatch(/price/)
    expect(c!.expression).toMatch(/>/)
  })

  it("reads a named index with unique flag", async () => {
    const driver = betterSqlite3Driver(db)
    const schema = {
      ix_posts: defineTable(
        "ix_posts",
        {
          id: integer().primaryKey(),
          title: text().notNull(),
        },
        {
          indexes: [{ name: "uq_ix_posts_title", columns: ["title"], unique: true }],
        },
      ),
    }
    const s = sumak({ dialect: sqliteDialect(), driver, tables: schema })
    await applyMigration(s, {}, schema)

    const introspected = await introspectSqlite(driver)
    const t = introspected.tables.find((x) => x.name === "ix_posts")!
    const idx = t.indexes?.find((x) => x.name === "uq_ix_posts_title")
    expect(idx).toBeDefined()
    expect(idx!.unique).toBe(true)
    expect([...idx!.columns]).toEqual(["title"])
  })

  it("does NOT emit a table-level index for PK or single-column UNIQUE", async () => {
    const driver = betterSqlite3Driver(db)
    const schema = {
      ix_plain: defineTable("ix_plain", {
        id: integer().primaryKey(),
        email: text().notNull().unique(),
      }),
    }
    const s = sumak({ dialect: sqliteDialect(), driver, tables: schema })
    await applyMigration(s, {}, schema)

    const introspected = await introspectSqlite(driver)
    const t = introspected.tables.find((x) => x.name === "ix_plain")!
    expect(t.indexes ?? []).toHaveLength(0)
  })
})
