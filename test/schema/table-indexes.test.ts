import { describe, expect, it } from "vitest"

import { integer, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"

describe("defineTable — indexes option", () => {
  it("round-trips a simple named index", () => {
    const t = defineTable(
      "users",
      { id: integer().primaryKey(), email: text().notNull() },
      { indexes: [{ name: "idx_users_email", columns: ["email"] }] },
    )
    expect(t.indexes).toHaveLength(1)
    expect(t.indexes?.[0]?.name).toBe("idx_users_email")
  })

  it("preserves unique and multi-column shape", () => {
    const t = defineTable(
      "members",
      { orgId: integer().notNull(), userId: integer().notNull() },
      {
        indexes: [
          {
            name: "uq_members_org_user",
            columns: [{ column: "orgId" }, { column: "userId", direction: "DESC" }],
            unique: true,
          },
        ],
      },
    )
    expect(t.indexes?.[0]?.unique).toBe(true)
    expect(t.indexes?.[0]?.columns).toHaveLength(2)
  })

  it("carries a partial index predicate (raw SQL)", () => {
    const t = defineTable(
      "posts",
      { id: integer().primaryKey(), deletedAt: integer().nullable() },
      {
        indexes: [
          {
            name: "idx_posts_active",
            columns: ["id"],
            where: "deletedAt IS NULL",
          },
        ],
      },
    )
    expect(t.indexes?.[0]?.where).toBe("deletedAt IS NULL")
  })
})
