import { describe, expect, it } from "vitest"

import type { AlterTableNode } from "../../src/ast/ddl-nodes.ts"
import { diffSchemas } from "../../src/migrate/diff.ts"
import { integer, serial, text } from "../../src/schema/column.ts"

describe("diffSchemas — explicit renames", () => {
  it("turns a column drop + add into a single RENAME COLUMN", () => {
    const before = {
      users: { id: serial().primaryKey(), user_name: text().notNull() },
    }
    const after = {
      users: { id: serial().primaryKey(), name: text().notNull() },
    }
    const nodes = diffSchemas(before, after, {
      renames: { columns: { "users.user_name": "name" } },
    })
    // No DROP COLUMN should appear: the rename consumes both the
    // remove (user_name) and the add (name). Only one ALTER TABLE
    // with a single rename_column action.
    expect(nodes).toHaveLength(1)
    const alter = nodes[0] as AlterTableNode
    expect(alter.actions).toEqual([{ kind: "rename_column", from: "user_name", to: "name" }])
  })

  it("RENAME TABLE via `renames.tables`", () => {
    const before = {
      posts: { id: serial().primaryKey(), title: text().notNull() },
    }
    const after = {
      articles: { id: serial().primaryKey(), title: text().notNull() },
    }
    const nodes = diffSchemas(before, after, {
      renames: { tables: { posts: "articles" } },
    })
    // A single ALTER TABLE ... RENAME TO articles — no CREATE, no DROP.
    const kinds = nodes
      .filter((n) => n.type === "alter_table")
      .flatMap((n) => (n as AlterTableNode).actions.map((a) => a.kind))
    expect(kinds).toContain("rename_table")
    expect(nodes.every((n) => n.type !== "drop_table")).toBe(true)
    expect(nodes.every((n) => n.type !== "create_table")).toBe(true)
  })

  it("column rename lands alongside attribute diff for the same column", () => {
    // `user_name TEXT NOT NULL` → renamed to `name` and made nullable.
    const before = {
      users: { id: serial().primaryKey(), user_name: text().notNull() },
    }
    const after = {
      users: { id: serial().primaryKey(), name: text().nullable() },
    }
    const nodes = diffSchemas(before, after, {
      renames: { columns: { "users.user_name": "name" } },
    })
    const alter = nodes[0] as AlterTableNode
    const kinds = alter.actions.map((a) => a.kind)
    expect(kinds).toContain("rename_column")
    // NOT NULL drop on the renamed column follows.
    expect(kinds).toContain("alter_column")
  })

  it("unknown rename keys are silent no-ops", () => {
    // The old schema doesn't have "ghost" — the rename map entry has
    // no referent. Diff should proceed as if the entry wasn't there.
    const before = { users: { id: serial().primaryKey() } }
    const after = { users: { id: serial().primaryKey() } }
    expect(() =>
      diffSchemas(before, after, { renames: { columns: { "users.ghost": "gone" } } }),
    ).not.toThrow()
  })

  it("rename with target column also added fresh — entry is ambiguous, ignored", () => {
    // Both the old name and new name are live in `after`. We can't
    // tell which is the rename target, so the diff falls back to
    // structural (drop + add).
    const before = {
      t: { id: serial().primaryKey(), old_col: text().notNull() },
    }
    const after = {
      t: {
        id: serial().primaryKey(),
        old_col: text().notNull(), // still present
        new_col: text().notNull(), // freshly added
      },
    }
    const nodes = diffSchemas(before, after, {
      renames: { columns: { "t.old_col": "new_col" } },
    })
    const alter = nodes[0] as AlterTableNode
    // No rename — just add_column.
    const kinds = alter.actions.map((a) => a.kind)
    expect(kinds).toContain("add_column")
    expect(kinds).not.toContain("rename_column")
  })
})

describe("diffSchemas — mixed renames + structural changes", () => {
  it("emits a rename, a column add, and a nullable tweak in one ALTER", () => {
    const before = {
      users: {
        id: serial().primaryKey(),
        user_name: text().notNull(),
        age: integer().notNull(),
      },
    }
    const after = {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(), // renamed from user_name
        age: integer().nullable(), // NOT NULL dropped
        email: text().notNull(), // brand new
      },
    }
    const nodes = diffSchemas(before, after, {
      renames: { columns: { "users.user_name": "name" } },
    })
    const alter = nodes[0] as AlterTableNode
    const kinds = alter.actions.map((a) => a.kind)
    expect(kinds).toContain("rename_column")
    expect(kinds).toContain("add_column")
    // `age`'s NOT NULL drop + a potential add for `email`.
    expect(kinds.filter((k) => k === "alter_column").length).toBeGreaterThanOrEqual(1)
  })
})
