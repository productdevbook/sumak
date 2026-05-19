import { describe, expect, it } from "vitest"

import type { CreateIndexNode, DropIndexNode } from "../../src/ast/ddl-nodes.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { diffSchemas } from "../../src/migrate/diff.ts"
import { integer, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import { sumak } from "../../src/sumak.ts"
import type { SQLDialect } from "../../src/types.ts"

// Partial indexes — `CREATE INDEX … WHERE <predicate>`. PG and SQLite
// (3.8+) accept the standard form. MySQL has no equivalent at all and
// MSSQL's "filtered indexes" use the same keyword but a stricter subset
// of allowed predicates; sumak refuses both rather than emit SQL the
// engine will reject (PG / SQLite go through; MySQL / MSSQL throw
// UnsupportedDialectFeatureError via the PARTIAL_INDEX feature flag).
//
// The predicate is part of the index's identity: two indexes sharing a
// name but differing in their WHERE clause are surfaced as drop +
// recreate by the diff engine, not a no-op.

function dialectFor(name: SQLDialect) {
  switch (name) {
    case "pg":
      return pgDialect()
    case "mysql":
      return mysqlDialect()
    case "sqlite":
      return sqliteDialect()
    case "mssql":
      return mssqlDialect()
  }
}

function compileWith(dialect: SQLDialect, nodes: { type: string }[]): string[] {
  const db = sumak({ dialect: dialectFor(dialect), tables: {} })
  return nodes.map(
    (n) => (db.compileDDL(n as Parameters<typeof db.compileDDL>[0]) as { sql: string }).sql,
  )
}

describe("partial index — schema DSL", () => {
  it("preserves the where predicate on the table definition (raw SQL form)", () => {
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

  it("preserves the where predicate alongside unique + using flags", () => {
    const t = defineTable(
      "orders",
      { id: integer().primaryKey(), orderNo: text().notNull(), status: text().notNull() },
      {
        indexes: [
          {
            name: "uq_orders_pending",
            columns: ["orderNo"],
            unique: true,
            where: "status = 'pending'",
          },
        ],
      },
    )
    expect(t.indexes?.[0]?.unique).toBe(true)
    expect(t.indexes?.[0]?.where).toBe("status = 'pending'")
  })
})

describe("partial index — diff materializes the predicate", () => {
  it("CreateIndexNode.where is set on new index creation", () => {
    const after = {
      posts: defineTable(
        "posts",
        { id: integer().primaryKey(), title: text().notNull(), deletedAt: integer().nullable() },
        {
          indexes: [
            {
              name: "idx_posts_active_title",
              columns: ["title"],
              where: "deletedAt IS NULL",
            },
          ],
        },
      ),
    }
    const nodes = diffSchemas({}, after)
    const created = nodes.find((n) => n.type === "create_index") as CreateIndexNode | undefined
    expect(created).toBeDefined()
    expect(created!.where).toBeDefined()
    // Raw-SQL form lowers to a `raw` ExpressionNode.
    expect(created!.where!.type).toBe("raw")
  })

  it("identical partial indexes produce empty diff", () => {
    const schema = {
      posts: defineTable(
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
      ),
    }
    expect(diffSchemas(schema, schema)).toEqual([])
  })

  it("changing the where predicate is treated as drop + recreate", () => {
    const before = {
      orders: defineTable(
        "orders",
        { id: integer().primaryKey(), status: text().notNull() },
        {
          indexes: [
            {
              name: "idx_orders_filter",
              columns: ["id"],
              where: "status = 'pending'",
            },
          ],
        },
      ),
    }
    const after = {
      orders: defineTable(
        "orders",
        { id: integer().primaryKey(), status: text().notNull() },
        {
          indexes: [
            {
              name: "idx_orders_filter",
              columns: ["id"],
              where: "status = 'shipped'",
            },
          ],
        },
      ),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const kinds = nodes.map((n) => n.type)
    expect(kinds).toContain("drop_index")
    expect(kinds).toContain("create_index")
    const dropped = nodes.find((n) => n.type === "drop_index") as DropIndexNode
    const added = nodes.find((n) => n.type === "create_index") as CreateIndexNode
    expect(dropped.name).toBe("idx_orders_filter")
    expect(added.name).toBe("idx_orders_filter")
    expect(added.where).toBeDefined()
  })

  it("adding a where predicate to an existing index is drop + recreate", () => {
    const before = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull() },
        { indexes: [{ name: "idx_users_email", columns: ["email"] }] },
      ),
    }
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull(), deletedAt: integer().nullable() },
        {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              where: "deletedAt IS NULL",
            },
          ],
        },
      ),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const kinds = nodes.map((n) => n.type)
    expect(kinds).toContain("drop_index")
    expect(kinds).toContain("create_index")
  })

  it("dropping a where predicate is drop + recreate", () => {
    const before = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull(), deletedAt: integer().nullable() },
        {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              where: "deletedAt IS NULL",
            },
          ],
        },
      ),
    }
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull(), deletedAt: integer().nullable() },
        { indexes: [{ name: "idx_users_email", columns: ["email"] }] },
      ),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const kinds = nodes.map((n) => n.type)
    expect(kinds).toContain("drop_index")
    expect(kinds).toContain("create_index")
  })
})

describe("partial index — DDL printer", () => {
  it("PG emits CREATE INDEX … WHERE …", () => {
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull(), deletedAt: integer().nullable() },
        {
          indexes: [
            {
              name: "idx_users_active",
              columns: ["email"],
              where: "deletedAt IS NULL",
            },
          ],
        },
      ),
    }
    const [, sql] = compileWith("pg", diffSchemas({}, after))
    expect(sql).toContain("CREATE INDEX")
    expect(sql).toContain(`"idx_users_active"`)
    expect(sql).toContain("WHERE")
    expect(sql).toContain("deletedAt IS NULL")
  })

  it("PG emits CREATE UNIQUE INDEX … WHERE … for unique partial indexes", () => {
    const after = {
      orders: defineTable(
        "orders",
        { id: integer().primaryKey(), orderNo: text().notNull(), status: text().notNull() },
        {
          indexes: [
            {
              name: "uq_orders_pending",
              columns: ["orderNo"],
              unique: true,
              where: "status = 'pending'",
            },
          ],
        },
      ),
    }
    const [, sql] = compileWith("pg", diffSchemas({}, after))
    expect(sql).toContain("CREATE UNIQUE INDEX")
    expect(sql).toContain("WHERE")
    expect(sql).toContain("status = 'pending'")
  })

  it("SQLite emits CREATE INDEX … WHERE … (identical grammar)", () => {
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), name: text().notNull() },
        {
          indexes: [
            {
              name: "idx_named",
              columns: ["name"],
              where: "name IS NOT NULL",
            },
          ],
        },
      ),
    }
    const [, sql] = compileWith("sqlite", diffSchemas({}, after))
    expect(sql).toContain("CREATE INDEX")
    expect(sql).toContain("WHERE")
    expect(sql).toContain("name IS NOT NULL")
  })

  it("MySQL throws UnsupportedDialectFeatureError (no partial index grammar)", () => {
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull() },
        {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              where: "email IS NOT NULL",
            },
          ],
        },
      ),
    }
    const nodes = diffSchemas({}, after)
    expect(() => compileWith("mysql", nodes)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL throws UnsupportedDialectFeatureError (filtered indexes have stricter rules)", () => {
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull() },
        {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              where: "email IS NOT NULL",
            },
          ],
        },
      ),
    }
    const nodes = diffSchemas({}, after)
    expect(() => compileWith("mssql", nodes)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL / MSSQL still print a regular (non-partial) index without throwing", () => {
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), email: text().notNull() },
        { indexes: [{ name: "idx_users_email", columns: ["email"] }] },
      ),
    }
    const nodes = diffSchemas({}, after)
    expect(() => compileWith("mysql", nodes)).not.toThrow()
    expect(() => compileWith("mssql", nodes)).not.toThrow()
  })
})

describe("partial index — builder ergonomics", () => {
  it("createIndex builder .where() accepts a raw AST node", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const node = db.schema
      .createIndex("idx_x")
      .on("users")
      .column("email")
      .where({ type: "raw", sql: "deleted_at IS NULL", params: [] })
      .build()
    expect(node.where).toBeDefined()
    expect(node.where!.type).toBe("raw")
  })

  it("createIndex builder .where() accepts an Expression<boolean> wrapper", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    // Expression<boolean> is `{ node: ExpressionNode }` shape — the same
    // form returned by `sql\`...\`` and by typed-builder callbacks.
    const expr = {
      node: { type: "raw", sql: "status = 'active'", params: [] },
    } as unknown as import("../../src/ast/typed-expression.ts").Expression<boolean>
    const node = db.schema.createIndex("idx_x").on("users").column("email").where(expr).build()
    expect(node.where).toBeDefined()
    expect(node.where!.type).toBe("raw")
    const q = db.compileDDL(node)
    expect(q.sql).toContain("WHERE status = 'active'")
  })
})
