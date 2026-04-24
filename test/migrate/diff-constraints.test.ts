import { describe, expect, it } from "vitest"

import type {
  AlterTableNode,
  CheckConstraintNode,
  CreateTableNode,
  ForeignKeyConstraintNode,
  PrimaryKeyConstraintNode,
  UniqueConstraintNode,
} from "../../src/ast/ddl-nodes.ts"
import { sql } from "../../src/builder/sql.ts"
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

describe("diffSchemas — table-level constraints", () => {
  describe("CREATE TABLE on a greenfield schema", () => {
    it("emits composite PRIMARY KEY constraint", () => {
      const after = {
        order_items: defineTable(
          "order_items",
          { orderId: integer().notNull(), sku: text().notNull(), qty: integer().notNull() },
          { constraints: { primaryKey: ["orderId", "sku"] } },
        ),
      }
      const nodes = diffSchemas({}, after)
      const create = nodes[0] as CreateTableNode
      const pk = create.constraints.find((c) => c.type === "pk_constraint") as
        | PrimaryKeyConstraintNode
        | undefined
      expect(pk).toBeDefined()
      expect(pk!.columns).toEqual(["orderId", "sku"])
    })

    it("emits named composite UNIQUE", () => {
      const after = {
        members: defineTable(
          "members",
          { orgId: integer().notNull(), userId: integer().notNull() },
          {
            constraints: {
              uniques: [{ name: "uq_members_org_user", columns: ["orgId", "userId"] }],
            },
          },
        ),
      }
      const nodes = diffSchemas({}, after)
      const create = nodes[0] as CreateTableNode
      const uq = create.constraints.find((c) => c.type === "unique_constraint") as
        | UniqueConstraintNode
        | undefined
      expect(uq).toBeDefined()
      expect(uq!.name).toBe("uq_members_org_user")
      expect(uq!.columns).toEqual(["orgId", "userId"])
    })

    it("emits table-level CHECK with raw SQL", () => {
      const after = {
        products: defineTable(
          "products",
          { id: integer().primaryKey(), price: integer().notNull() },
          { constraints: { checks: [{ name: "ck_price_pos", expression: "price > 0" }] } },
        ),
      }
      const nodes = diffSchemas({}, after)
      const create = nodes[0] as CreateTableNode
      const ck = create.constraints.find((c) => c.type === "check_constraint") as
        | CheckConstraintNode
        | undefined
      expect(ck).toBeDefined()
      expect(ck!.name).toBe("ck_price_pos")
      const [sqlStr] = compile([create])
      expect(sqlStr).toContain("CHECK")
      expect(sqlStr).toContain("price > 0")
      expect(sqlStr).toContain(`CONSTRAINT "ck_price_pos"`)
    })

    it("emits named FK pointing to another table; topo order respected", () => {
      const after = {
        users: defineTable("users", { id: integer().primaryKey() }),
        posts: defineTable(
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
        ),
      }
      const nodes = diffSchemas({}, after)
      const names = nodes.map((n) => (n as CreateTableNode).table.name)
      expect(names.indexOf("users")).toBeLessThan(names.indexOf("posts"))
      const postsCreate = nodes.find(
        (n) => (n as CreateTableNode).table.name === "posts",
      ) as CreateTableNode
      const fk = postsCreate.constraints.find((c) => c.type === "fk_constraint") as
        | ForeignKeyConstraintNode
        | undefined
      expect(fk).toBeDefined()
      expect(fk!.name).toBe("fk_posts_author")
      expect(fk!.references.onDelete).toBe("CASCADE")
    })
  })

  describe("ALTER TABLE on shared tables", () => {
    it("emits ADD CONSTRAINT when a new unique appears", () => {
      const before = {
        members: defineTable("members", {
          orgId: integer().notNull(),
          userId: integer().notNull(),
        }),
      }
      const after = {
        members: defineTable(
          "members",
          { orgId: integer().notNull(), userId: integer().notNull() },
          {
            constraints: {
              uniques: [{ name: "uq_members", columns: ["orgId", "userId"] }],
            },
          },
        ),
      }
      const nodes = diffSchemas(before, after)
      expect(nodes).toHaveLength(1)
      const alter = nodes[0] as AlterTableNode
      expect(alter.actions).toHaveLength(1)
      expect(alter.actions[0]!.kind).toBe("add_constraint")
    })

    it("emits DROP CONSTRAINT when a named constraint disappears — gated by allowDestructive? no, it's additive", () => {
      // Dropping a CONSTRAINT without dropping data is *not* destructive
      // at the row level (a relaxed CHECK loses no data). We emit it on
      // the destructive side because ALTER TABLE DROP CONSTRAINT is
      // still a schema action the author should see. `allowDestructive`
      // treats it like a column drop for safety.
      const before = {
        products: defineTable(
          "products",
          { id: integer().primaryKey(), price: integer().notNull() },
          { constraints: { checks: [{ name: "ck_price_pos", expression: "price > 0" }] } },
        ),
      }
      const after = {
        products: defineTable("products", {
          id: integer().primaryKey(),
          price: integer().notNull(),
        }),
      }
      const nodes = diffSchemas(before, after, { allowDestructive: true })
      expect(nodes).toHaveLength(1)
      const alter = nodes[0] as AlterTableNode
      const drop = alter.actions.find((a) => a.kind === "drop_constraint")
      expect(drop).toBeDefined()
    })

    it("Expression-form CHECK survives through to the compiled SQL", () => {
      const after = {
        products: defineTable(
          "products",
          { id: integer().primaryKey(), price: integer().notNull() },
          {
            constraints: {
              checks: [{ name: "ck_price", expression: sql<boolean>`price >= 0` }],
            },
          },
        ),
      }
      const [sqlStr] = compile(diffSchemas({}, after))
      expect(sqlStr).toContain("CHECK")
      expect(sqlStr).toContain("price")
    })
  })

  describe("back-compat", () => {
    it("raw columns-map entry still works when mixed with defineTable", () => {
      const after = {
        users: { id: integer().primaryKey(), name: text().notNull() },
        orders: defineTable(
          "orders",
          { id: integer().primaryKey(), userId: integer().notNull() },
          {
            constraints: {
              foreignKeys: [
                {
                  columns: ["userId"],
                  references: { table: "users", columns: ["id"] },
                },
              ],
            },
          },
        ),
      }
      const nodes = diffSchemas({}, after)
      const names = nodes.map((n) => (n as CreateTableNode).table.name)
      expect(names).toEqual(expect.arrayContaining(["users", "orders"]))
    })
  })
})
