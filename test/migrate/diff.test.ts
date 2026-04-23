import { describe, expect, it } from "vitest"

import type { AlterTableNode, CreateTableNode, DropTableNode } from "../../src/ast/ddl-nodes.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { DestructiveMigrationError, diffSchemas } from "../../src/migrate/diff.ts"
import { integer, serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"

// Running the DDL through db.compileDDL is the easiest way to confirm
// the generated nodes print to valid SQL — no in-memory driver needed.
function compile(nodes: { type: string }[]): string[] {
  const db = sumak({ dialect: pgDialect(), tables: {} })
  return nodes.map(
    (n) => (db.compileDDL(n as Parameters<typeof db.compileDDL>[0]) as { sql: string }).sql,
  )
}

describe("diffSchemas", () => {
  describe("greenfield (empty before)", () => {
    it("emits CREATE TABLE for each added table", () => {
      const after = {
        users: { id: serial().primaryKey(), name: text().notNull() },
        posts: {
          id: serial().primaryKey(),
          title: text().notNull(),
          userId: integer().references("users", "id"),
        },
      }
      const nodes = diffSchemas({}, after)
      expect(nodes.every((n) => n.type === "create_table")).toBe(true)
      expect(nodes).toHaveLength(2)
      // Topo order: users before posts (posts.userId references users).
      const names = nodes.map((n) => (n as CreateTableNode).table.name)
      expect(names.indexOf("users")).toBeLessThan(names.indexOf("posts"))
    })

    it("produces compilable SQL", () => {
      const after = { users: { id: serial().primaryKey(), name: text().notNull() } }
      const sqls = compile(diffSchemas({}, after))
      expect(sqls[0]).toContain("CREATE TABLE")
      expect(sqls[0]).toContain(`"users"`)
      expect(sqls[0]).toContain(`"name"`)
    })
  })

  describe("additive changes", () => {
    it("ALTER TABLE ... ADD COLUMN for new columns", () => {
      const before = { users: { id: serial().primaryKey(), name: text().notNull() } }
      const after = {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          age: integer().nullable(),
        },
      }
      const nodes = diffSchemas(before, after)
      expect(nodes).toHaveLength(1)
      expect(nodes[0]!.type).toBe("alter_table")
      const alter = nodes[0] as AlterTableNode
      expect(alter.actions).toHaveLength(1)
      expect(alter.actions[0]!.kind).toBe("add_column")
    })

    it("type / NOT-NULL changes produce alter_column actions", () => {
      const before = { users: { name: text().nullable() } }
      const after = { users: { name: text().notNull() } }
      const nodes = diffSchemas(before, after)
      const alter = nodes[0] as AlterTableNode
      const kinds = alter.actions.map((a) => (a.kind === "alter_column" ? a.set.type : a.kind))
      expect(kinds).toContain("set_not_null")
    })
  })

  describe("destructive changes", () => {
    it("throws DestructiveMigrationError on DROP TABLE without opt-in", () => {
      const before = { old_table: { id: serial().primaryKey() } }
      const after = {}
      expect(() => diffSchemas(before, after)).toThrow(DestructiveMigrationError)
    })

    it("throws DestructiveMigrationError on DROP COLUMN without opt-in", () => {
      const before = { users: { id: serial().primaryKey(), gone: text() } }
      const after = { users: { id: serial().primaryKey() } }
      expect(() => diffSchemas(before, after)).toThrow(DestructiveMigrationError)
    })

    it("allowDestructive: true emits DROP TABLE", () => {
      const before = { old_table: { id: serial().primaryKey() } }
      const after = {}
      const nodes = diffSchemas(before, after, { allowDestructive: true })
      expect(nodes).toHaveLength(1)
      expect(nodes[0]!.type).toBe("drop_table")
      expect((nodes[0] as DropTableNode).table.name).toBe("old_table")
    })

    it("allowDestructive: 'ignore' skips drops but applies additive changes", () => {
      const before = { old_table: { id: serial().primaryKey() } }
      const after = {
        old_table: { id: serial().primaryKey() },
        new_table: { id: serial().primaryKey() },
      }
      // Add DROP to force destructive path
      const after2 = { new_table: { id: serial().primaryKey() } }
      const nodes = diffSchemas(before, after2, { allowDestructive: "ignore" })
      expect(nodes.every((n) => n.type !== "drop_table")).toBe(true)
      // The CREATE for new_table still fires.
      expect(nodes.some((n) => n.type === "create_table")).toBe(true)
    })
  })

  describe("ordering", () => {
    it("drops happen before creates / adds", () => {
      const before = {
        old_table: { id: serial().primaryKey() },
        users: { id: serial().primaryKey() },
      }
      const after = {
        users: { id: serial().primaryKey(), name: text().notNull() },
        posts: { id: serial().primaryKey() },
      }
      const nodes = diffSchemas(before, after, { allowDestructive: true })
      const kinds = nodes.map((n) => n.type)
      const dropIdx = kinds.indexOf("drop_table")
      const createIdx = kinds.indexOf("create_table")
      const alterIdx = kinds.indexOf("alter_table")
      expect(dropIdx).toBeLessThan(createIdx)
      expect(createIdx).toBeLessThan(alterIdx)
    })
  })

  describe("no-op", () => {
    it("identical schemas produce an empty diff", () => {
      const schema = { users: { id: serial().primaryKey(), name: text().notNull() } }
      expect(diffSchemas(schema, schema)).toEqual([])
    })
  })
})
