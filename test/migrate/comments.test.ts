import { describe, expect, it } from "vitest"

import type { CommentNode, CreateTableNode } from "../../src/ast/ddl-nodes.ts"
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

// Object comments — PG and MySQL only. The PG surface is two statements
// (`COMMENT ON TABLE` and `COMMENT ON COLUMN`); MySQL has an inline
// column-comment form on `CREATE TABLE` and a standalone `ALTER TABLE
// … COMMENT = '…'` for table comments (column-level standalone is not
// supported — MySQL requires the full type at modification time). SQLite
// and MSSQL refuse via UnsupportedDialectFeatureError.

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

describe("comments — schema DSL", () => {
  it("preserves a column-level comment via .comment()", () => {
    const t = defineTable("users", {
      id: integer().primaryKey(),
      email: text().notNull().comment("Primary contact; case-folded on insert"),
    })
    expect(t.columns.email._def.comment).toBe("Primary contact; case-folded on insert")
  })

  it("preserves a table-level comment via defineTable options", () => {
    const t = defineTable(
      "users",
      { id: integer().primaryKey() },
      { comment: "User accounts (renamed from old_users in v1.2)" },
    )
    expect(t.comment).toBe("User accounts (renamed from old_users in v1.2)")
  })
})

describe("comments — diff materialization", () => {
  it("emits a COMMENT ON TABLE node for a fresh table with a table comment", () => {
    const after = {
      users: defineTable("users", { id: integer().primaryKey() }, { comment: "User accounts" }),
    }
    const nodes = diffSchemas({}, after)
    const comment = nodes.find((n) => n.type === "comment_on") as CommentNode | undefined
    expect(comment).toBeDefined()
    expect(comment!.target).toBe("table")
    expect(comment!.tableName).toBe("users")
    expect(comment!.comment).toBe("User accounts")
  })

  it("emits a COMMENT ON COLUMN node for a fresh table with a column comment", () => {
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().comment("case-folded on insert"),
      }),
    }
    const nodes = diffSchemas({}, after)
    const comment = nodes.find(
      (n) => n.type === "comment_on" && (n as CommentNode).target === "column",
    ) as CommentNode | undefined
    expect(comment).toBeDefined()
    expect(comment!.tableName).toBe("users")
    expect(comment!.columnName).toBe("email")
    expect(comment!.comment).toBe("case-folded on insert")
  })

  it("threads the comment onto ColumnDefinitionNode for the create_table path", () => {
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().comment("case-folded on insert"),
      }),
    }
    const nodes = diffSchemas({}, after)
    const create = nodes.find((n) => n.type === "create_table") as CreateTableNode | undefined
    expect(create).toBeDefined()
    const emailCol = create!.columns.find((c) => c.name === "email")
    expect(emailCol).toBeDefined()
    expect(emailCol!.comment).toBe("case-folded on insert")
  })

  it("adding a column comment to an existing column emits a COMMENT ON COLUMN node", () => {
    const before = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull(),
      }),
    }
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().comment("case-folded on insert"),
      }),
    }
    const nodes = diffSchemas(before, after)
    const comment = nodes.find((n) => n.type === "comment_on") as CommentNode | undefined
    expect(comment).toBeDefined()
    expect(comment!.target).toBe("column")
    expect(comment!.columnName).toBe("email")
    expect(comment!.comment).toBe("case-folded on insert")
  })

  it("editing a column comment emits a new COMMENT ON COLUMN node", () => {
    const before = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().comment("first revision"),
      }),
    }
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().comment("second revision"),
      }),
    }
    const nodes = diffSchemas(before, after)
    const comment = nodes.find((n) => n.type === "comment_on") as CommentNode | undefined
    expect(comment).toBeDefined()
    expect(comment!.comment).toBe("second revision")
  })

  it("dropping a column comment emits a CommentNode with comment=null", () => {
    const before = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().comment("old comment"),
      }),
    }
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull(),
      }),
    }
    const nodes = diffSchemas(before, after)
    const comment = nodes.find((n) => n.type === "comment_on") as CommentNode | undefined
    expect(comment).toBeDefined()
    expect(comment!.comment).toBeNull()
  })

  it("identical schemas with comments produce an empty diff", () => {
    const schema = {
      users: defineTable(
        "users",
        {
          id: integer().primaryKey(),
          email: text().notNull().comment("primary"),
        },
        { comment: "users table" },
      ),
    }
    expect(diffSchemas(schema, schema)).toEqual([])
  })

  it("editing the table-level comment emits a COMMENT ON TABLE node", () => {
    const before = {
      users: defineTable("users", { id: integer().primaryKey() }, { comment: "old description" }),
    }
    const after = {
      users: defineTable("users", { id: integer().primaryKey() }, { comment: "new description" }),
    }
    const nodes = diffSchemas(before, after)
    const comment = nodes.find((n) => n.type === "comment_on") as CommentNode | undefined
    expect(comment).toBeDefined()
    expect(comment!.target).toBe("table")
    expect(comment!.comment).toBe("new description")
  })
})

describe("comments — PG printer", () => {
  it("emits COMMENT ON TABLE …  IS '…' for a table comment", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "table",
      tableName: "users",
      comment: "User accounts",
    }
    const [sql] = compileWith("pg", [node])
    expect(sql).toBe(`COMMENT ON TABLE "users" IS 'User accounts'`)
  })

  it("emits COMMENT ON COLUMN …  IS '…' for a column comment", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "column",
      tableName: "users",
      columnName: "email",
      comment: "case-folded on insert",
    }
    const [sql] = compileWith("pg", [node])
    expect(sql).toBe(`COMMENT ON COLUMN "users"."email" IS 'case-folded on insert'`)
  })

  it("emits IS NULL when dropping a comment", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "table",
      tableName: "users",
      comment: null,
    }
    const [sql] = compileWith("pg", [node])
    expect(sql).toBe(`COMMENT ON TABLE "users" IS NULL`)
  })

  it("does NOT inline a column comment inside CREATE TABLE (PG has no inline form)", () => {
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().comment("case-folded"),
      }),
    }
    const nodes = diffSchemas({}, after)
    const createNode = nodes.find((n) => n.type === "create_table")
    expect(createNode).toBeDefined()
    const [createSql] = compileWith("pg", [createNode!])
    expect(createSql).not.toContain("COMMENT")
    expect(createSql).not.toContain("case-folded")
    // The comment surfaces as a separate COMMENT ON COLUMN statement.
    const commentNode = nodes.find((n) => n.type === "comment_on")
    expect(commentNode).toBeDefined()
    const [commentSql] = compileWith("pg", [commentNode!])
    expect(commentSql).toContain("COMMENT ON COLUMN")
    expect(commentSql).toContain("case-folded")
  })

  it("escapes single quotes in the comment literal (PG: '' doubled form)", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "column",
      tableName: "users",
      columnName: "note",
      comment: "Alice's note",
    }
    const [sql] = compileWith("pg", [node])
    // ANSI SQL string-literal escape: '' inside the quoted literal.
    expect(sql).toBe(`COMMENT ON COLUMN "users"."note" IS 'Alice''s note'`)
  })
})

describe("comments — MySQL printer", () => {
  it("inlines a column comment inside CREATE TABLE", () => {
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().comment("case-folded on insert"),
      }),
    }
    const nodes = diffSchemas({}, after)
    const createNode = nodes.find((n) => n.type === "create_table")
    expect(createNode).toBeDefined()
    const [sql] = compileWith("mysql", [createNode!])
    expect(sql).toContain("COMMENT 'case-folded on insert'")
  })

  it("emits ALTER TABLE … COMMENT = '…' for a standalone table comment", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "table",
      tableName: "users",
      comment: "User accounts",
    }
    const [sql] = compileWith("mysql", [node])
    expect(sql).toBe("ALTER TABLE `users` COMMENT = 'User accounts'")
  })

  it("dropping a table comment emits ALTER TABLE … COMMENT = ''", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "table",
      tableName: "users",
      comment: null,
    }
    const [sql] = compileWith("mysql", [node])
    expect(sql).toBe("ALTER TABLE `users` COMMENT = ''")
  })

  it("refuses a standalone column comment (MySQL needs the column type)", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "column",
      tableName: "users",
      columnName: "email",
      comment: "case-folded",
    }
    expect(() => compileWith("mysql", [node])).toThrow(UnsupportedDialectFeatureError)
  })

  it("escapes single quotes in the inline comment literal", () => {
    const after = {
      notes: defineTable("notes", {
        id: integer().primaryKey(),
        body: text().notNull().comment("Alice's note"),
      }),
    }
    const nodes = diffSchemas({}, after)
    const createNode = nodes.find((n) => n.type === "create_table")
    expect(createNode).toBeDefined()
    const [sql] = compileWith("mysql", [createNode!])
    expect(sql).toContain("COMMENT 'Alice''s note'")
  })
})

describe("comments — refused dialects", () => {
  it("SQLite refuses a standalone COMMENT ON TABLE", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "table",
      tableName: "users",
      comment: "ignored",
    }
    expect(() => compileWith("sqlite", [node])).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite refuses a standalone COMMENT ON COLUMN", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "column",
      tableName: "users",
      columnName: "email",
      comment: "ignored",
    }
    expect(() => compileWith("sqlite", [node])).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL refuses a standalone COMMENT ON TABLE", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "table",
      tableName: "users",
      comment: "ignored",
    }
    expect(() => compileWith("mssql", [node])).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL refuses a standalone COMMENT ON COLUMN", () => {
    const node: CommentNode = {
      type: "comment_on",
      target: "column",
      tableName: "users",
      columnName: "email",
      comment: "ignored",
    }
    expect(() => compileWith("mssql", [node])).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite omits the inline column comment from CREATE TABLE rather than emit junk", () => {
    // The standalone-CommentNode path throws on SQLite, but the inline-
    // comment field on ColumnDefinitionNode is silently dropped in
    // CREATE TABLE because emitting `COMMENT '…'` after a column
    // definition is not portable to SQLite at all. (The DSL still
    // accepts `.comment(...)` because the same schema may be reused
    // across dialects.)
    const def: CreateTableNode = {
      type: "create_table",
      table: { type: "table_ref", name: "users" },
      columns: [
        {
          type: "column_definition",
          name: "id",
          dataType: "integer",
          primaryKey: true,
        },
        {
          type: "column_definition",
          name: "email",
          dataType: "text",
          notNull: true,
          comment: "case-folded",
        },
      ],
      constraints: [],
    }
    const [sql] = compileWith("sqlite", [def])
    expect(sql).not.toContain("COMMENT")
    expect(sql).not.toContain("case-folded")
  })
})

describe("comments — round-trip via diff", () => {
  it("adding a comment to an existing PG table produces a COMMENT ON statement", () => {
    const before = {
      users: defineTable("users", { id: integer().primaryKey(), name: text().notNull() }),
    }
    const after = {
      users: defineTable(
        "users",
        { id: integer().primaryKey(), name: text().notNull() },
        { comment: "the users table" },
      ),
    }
    const nodes = diffSchemas(before, after)
    const sqls = compileWith("pg", nodes)
    expect(sqls.some((s) => s.startsWith("COMMENT ON TABLE"))).toBe(true)
    expect(sqls.some((s) => s.includes("the users table"))).toBe(true)
  })
})
