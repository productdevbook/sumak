import { describe, expect, it } from "vitest"

import type { CreateIndexNode, DropIndexNode } from "../../src/ast/ddl-nodes.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { diffSchemas } from "../../src/migrate/diff.ts"
import { integer, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import { sumak } from "../../src/sumak.ts"

function compile(nodes: { type: string }[]): string[] {
  const db = sumak({ dialect: pgDialect(), tables: {} })
  return nodes.map(
    (n) => (db.compileDDL(n as Parameters<typeof db.compileDDL>[0]) as { sql: string }).sql,
  )
}

describe("diffSchemas — indexes", () => {
  it("creates indexes for a new table after its CREATE TABLE", () => {
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull() },
        { indexes: [{ name: "idx_users_email", columns: ["email"], unique: true }] },
      ),
    }
    const nodes = diffSchemas({}, after)
    expect(nodes[0]!.type).toBe("create_table")
    expect(nodes[1]!.type).toBe("create_index")
    const idx = nodes[1] as CreateIndexNode
    expect(idx.name).toBe("idx_users_email")
    expect(idx.unique).toBe(true)
    const [, sql] = compile(nodes)
    expect(sql).toContain("CREATE UNIQUE INDEX")
    expect(sql).toContain(`"idx_users_email"`)
  })

  it("emits CREATE INDEX for a new index on a shared table", () => {
    const before = {
      users: defineTable("users", { id: integer().primaryKey(), email: text().notNull() }),
    }
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull() },
        { indexes: [{ name: "idx_users_email", columns: ["email"] }] },
      ),
    }
    const nodes = diffSchemas(before, after)
    const created = nodes.find((n) => n.type === "create_index") as CreateIndexNode | undefined
    expect(created).toBeDefined()
    expect(created!.name).toBe("idx_users_email")
  })

  it("emits DROP INDEX when an index disappears", () => {
    const before = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull() },
        { indexes: [{ name: "idx_users_email", columns: ["email"] }] },
      ),
    }
    const after = {
      users: defineTable("users", { id: integer().primaryKey(), email: text().notNull() }),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const dropped = nodes.find((n) => n.type === "drop_index") as DropIndexNode | undefined
    expect(dropped).toBeDefined()
    expect(dropped!.name).toBe("idx_users_email")
  })

  it("DROP + CREATE on a body change (column-set flipped)", () => {
    const before = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), a: text().notNull(), b: text().notNull() },
        { indexes: [{ name: "idx_users_ab", columns: ["a"] }] },
      ),
    }
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), a: text().notNull(), b: text().notNull() },
        { indexes: [{ name: "idx_users_ab", columns: ["a", "b"] }] },
      ),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const kinds = nodes.map((n) => n.type)
    expect(kinds).toContain("drop_index")
    expect(kinds).toContain("create_index")
  })

  it("drops indexes before dropping the owning table", () => {
    const before = {
      users: defineTable(
        "users",
        { id: integer().primaryKey() },
        { indexes: [{ name: "idx_u", columns: ["id"] }] },
      ),
    }
    const after = {}
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const dropIndexIdx = nodes.findIndex((n) => n.type === "drop_index")
    const dropTableIdx = nodes.findIndex((n) => n.type === "drop_table")
    expect(dropIndexIdx).toBeGreaterThanOrEqual(0)
    expect(dropIndexIdx).toBeLessThan(dropTableIdx)
  })
})
