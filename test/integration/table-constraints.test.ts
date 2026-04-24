import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { integer, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG proof that defineTable's constraints option makes it all the
// way through the migrator and is enforced by the engine. A composite
// PK rejects duplicate (orderId, sku) pairs; a table-level CHECK
// rejects a bad qty.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

describe("table-level constraints — pglite roundtrip", () => {
  it("enforces a composite PRIMARY KEY", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      oi_composite: defineTable(
        "oi_composite",
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

    await db.insertInto("oi_composite").values({ orderId: 1, sku: "A", qty: 2 }).exec()
    await db.insertInto("oi_composite").values({ orderId: 1, sku: "B", qty: 3 }).exec()

    // Duplicate (orderId, sku) — must fail on the composite PK.
    await expect(
      db.insertInto("oi_composite").values({ orderId: 1, sku: "A", qty: 99 }).exec(),
    ).rejects.toThrow(/duplicate key|primary key/i)
  })

  it("enforces a named table-level CHECK", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      tc_products: defineTable(
        "tc_products",
        { id: integer().primaryKey(), price: integer().notNull() },
        {
          constraints: {
            checks: [{ name: "ck_tc_price_pos", expression: "price > 0" }],
          },
        },
      ),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    await db.insertInto("tc_products").values({ id: 1, price: 10 }).exec()
    await expect(db.insertInto("tc_products").values({ id: 2, price: 0 }).exec()).rejects.toThrow(
      /ck_tc_price_pos|check/i,
    )
  })

  it("enforces a named composite UNIQUE added via ALTER", async () => {
    const driver = pgliteDriver(pg)
    const before = {
      tc_members: defineTable("tc_members", {
        orgId: integer().notNull(),
        userId: integer().notNull(),
      }),
    }
    const after = {
      tc_members: defineTable(
        "tc_members",
        { orgId: integer().notNull(), userId: integer().notNull() },
        {
          constraints: {
            uniques: [{ name: "uq_tc_members", columns: ["orgId", "userId"] }],
          },
        },
      ),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: after })
    await applyMigration(db, {}, before)
    await db.insertInto("tc_members").values({ orgId: 1, userId: 1 }).exec()
    await db.insertInto("tc_members").values({ orgId: 1, userId: 2 }).exec()
    await applyMigration(db, before, after)

    // Unique now active — a duplicate must fail.
    await expect(
      db.insertInto("tc_members").values({ orgId: 1, userId: 1 }).exec(),
    ).rejects.toThrow(/duplicate key|uq_tc_members|unique/i)
  })

  it("enforces a named composite FOREIGN KEY with ON DELETE CASCADE", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      tc_users: defineTable("tc_users", {
        id: integer().primaryKey(),
        name: text().notNull(),
      }),
      tc_posts: defineTable(
        "tc_posts",
        { id: integer().primaryKey(), authorId: integer().notNull() },
        {
          constraints: {
            foreignKeys: [
              {
                name: "fk_tc_posts_author",
                columns: ["authorId"],
                references: { table: "tc_users", columns: ["id"] },
                onDelete: "CASCADE",
              },
            ],
          },
        },
      ),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    await db.insertInto("tc_users").values({ id: 1, name: "Alice" }).exec()
    await db.insertInto("tc_posts").values({ id: 10, authorId: 1 }).exec()

    // Cascade: deleting the user should drop the post.
    await db
      .deleteFrom("tc_users")
      .where(({ id }) => id.eq(1))
      .exec()
    const posts = await db.selectFrom("tc_posts").selectAll().many()
    expect(posts).toHaveLength(0)
  })
})
