import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { introspectPg } from "../../src/introspect/pg.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { integer, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// The introspector recovers what defineTable put in — composite PK,
// named composite UNIQUE, CHECK, named composite FK, and named indexes.
// Proves the round trip: schema → migrate → pg catalogs → introspect →
// back to a shape that looks like what we started from.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

describe("introspectPg — recovers table-level constraints and indexes", () => {
  it("reads a composite PK", async () => {
    const driver = pgliteDriver(pg)
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
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    const introspected = await introspectPg(driver)
    const t = introspected.tables.find((x) => x.name === "ix_order_items")!
    expect(t.constraints?.primaryKey?.columns).toEqual(["orderId", "sku"])
  })

  it("reads a named composite UNIQUE", async () => {
    const driver = pgliteDriver(pg)
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
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    const introspected = await introspectPg(driver)
    const t = introspected.tables.find((x) => x.name === "ix_members")!
    expect(t.constraints?.uniques?.[0]?.name).toBe("uq_ix_members")
    expect([...(t.constraints?.uniques?.[0]?.columns ?? [])]).toEqual(["orgId", "userId"])
  })

  it("reads table-level CHECK with a recognisable body", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      ix_products: defineTable(
        "ix_products",
        { id: integer().primaryKey(), price: integer().notNull() },
        { constraints: { checks: [{ name: "ck_ix_price_pos", expression: "price > 0" }] } },
      ),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    const introspected = await introspectPg(driver)
    const t = introspected.tables.find((x) => x.name === "ix_products")!
    const c = t.constraints?.checks?.find((x) => x.name === "ck_ix_price_pos")
    expect(c).toBeDefined()
    // PG reformats the body through the parser; match just on the
    // essential tokens rather than on whitespace / parens.
    expect(c!.expression).toMatch(/price/)
    expect(c!.expression).toMatch(/>/)
  })

  it("reads a named index with unique flag and partial WHERE", async () => {
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
              name: "uq_ix_posts_title_active",
              columns: ["title"],
              unique: true,
              where: '"deletedAt" IS NULL',
            },
          ],
        },
      ),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    const introspected = await introspectPg(driver)
    const t = introspected.tables.find((x) => x.name === "ix_posts")!
    const idx = t.indexes?.find((x) => x.name === "uq_ix_posts_title_active")
    expect(idx).toBeDefined()
    expect(idx!.unique).toBe(true)
    expect(idx!.where).toMatch(/deletedAt|deleted_at/i)
    expect(idx!.where).toMatch(/IS NULL/i)
  })

  it("does NOT emit a table-level index for primary-key or unique-constraint indexes", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      ix_plain: defineTable("ix_plain", {
        id: integer().primaryKey(),
        email: text().notNull().unique(),
      }),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    const introspected = await introspectPg(driver)
    const t = introspected.tables.find((x) => x.name === "ix_plain")!
    // PK and single-column UNIQUE both create implicit indexes in PG;
    // the introspector filters those out so re-applying the schema
    // doesn't produce duplicates.
    expect(t.indexes ?? []).toHaveLength(0)
  })
})
