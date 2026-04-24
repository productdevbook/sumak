import { describe, expect, it } from "vitest"

import { sql } from "../../src/builder/sql.ts"
import { integer, text } from "../../src/schema/column.ts"
import { defineTable, isTableDefinition } from "../../src/schema/table.ts"

// Public API for table-level constraints: composite primary key,
// composite unique, table-level CHECK, named / composite foreign key.
// defineTable's third argument is the "advanced" slot; omitting it
// keeps the legacy two-arg form working unchanged.

describe("defineTable — constraints option", () => {
  it("round-trips a composite primary key", () => {
    const t = defineTable(
      "order_items",
      {
        orderId: integer().notNull(),
        sku: text().notNull(),
        qty: integer().notNull(),
      },
      { constraints: { primaryKey: ["orderId", "sku"] } },
    )
    expect(t.constraints?.primaryKey).toEqual(["orderId", "sku"])
  })

  it("round-trips a named composite unique", () => {
    const t = defineTable(
      "members",
      { orgId: integer().notNull(), userId: integer().notNull() },
      {
        constraints: {
          uniques: [{ name: "uq_members_org_user", columns: ["orgId", "userId"] }],
        },
      },
    )
    expect(t.constraints?.uniques?.[0]).toEqual({
      name: "uq_members_org_user",
      columns: ["orgId", "userId"],
    })
  })

  it("round-trips a CHECK with Expression form", () => {
    const t = defineTable(
      "products",
      { id: integer().primaryKey(), price: integer().notNull() },
      {
        constraints: {
          checks: [{ name: "ck_price_pos", expression: sql<boolean>`price > 0` }],
        },
      },
    )
    expect(t.constraints?.checks?.[0]?.name).toBe("ck_price_pos")
    expect(typeof t.constraints?.checks?.[0]?.expression).toBe("object")
  })

  it("round-trips a named foreign key", () => {
    const t = defineTable(
      "posts",
      { id: integer().primaryKey(), authorId: integer().notNull() },
      {
        constraints: {
          foreignKeys: [
            {
              name: "fk_posts_author",
              columns: ["authorId"],
              references: { table: "users", columns: ["id"] },
              onDelete: "CASCADE",
            },
          ],
        },
      },
    )
    expect(t.constraints?.foreignKeys?.[0]?.name).toBe("fk_posts_author")
    expect(t.constraints?.foreignKeys?.[0]?.onDelete).toBe("CASCADE")
  })

  it("isTableDefinition distinguishes wrapper from raw columns map", () => {
    const wrapped = defineTable("users", { id: integer().primaryKey() })
    const raw = { id: integer().primaryKey() }
    expect(isTableDefinition(wrapped)).toBe(true)
    expect(isTableDefinition(raw)).toBe(false)
  })

  it("legacy two-arg form still works (no constraints field attached)", () => {
    const t = defineTable("users", { id: integer().primaryKey() })
    expect(t.constraints).toBeUndefined()
  })
})
