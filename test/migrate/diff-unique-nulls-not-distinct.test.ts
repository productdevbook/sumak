import { describe, expect, it } from "vitest"

import type {
  AlterTableNode,
  CreateTableNode,
  UniqueConstraintNode,
} from "../../src/ast/ddl-nodes.ts"
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

// `UNIQUE NULLS NOT DISTINCT` — PG 15+ only. The modifier flips the
// default NULL-comparison rule (NULLs are distinct → multiple rows can
// share NULL) so that NULLs compare equal and only one row may carry
// NULL across the constraint's columns. Sumak threads the flag through
// at three layers: the schema DSL (`.unique({ nullsNotDistinct: true })`
// + table-level `{ uniques: [{ columns, nullsNotDistinct: true }] }`),
// the diff engine (preserves it across drop/add and column-level
// emission), and the DDL printer (PG emits `NULLS NOT DISTINCT`,
// MySQL / SQLite / MSSQL throw `UnsupportedDialectFeatureError`).

const DIALECTS: { name: SQLDialect }[] = [
  { name: "pg" },
  { name: "mysql" },
  { name: "sqlite" },
  { name: "mssql" },
]

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

describe("UNIQUE NULLS NOT DISTINCT — schema DSL", () => {
  it("column-level .unique({ nullsNotDistinct: true }) sets the flag", () => {
    const col = text().nullable().unique({ nullsNotDistinct: true })
    expect(col._def.isUnique).toBe(true)
    expect(col._def.uniqueNullsNotDistinct).toBe(true)
  })

  it("column-level .unique() without opts leaves the flag unset", () => {
    const col = text().nullable().unique()
    expect(col._def.isUnique).toBe(true)
    expect(col._def.uniqueNullsNotDistinct).toBeUndefined()
  })

  it("column-level .unique({ nullsNotDistinct: false }) does not set the flag", () => {
    const col = text().nullable().unique({ nullsNotDistinct: false })
    expect(col._def.isUnique).toBe(true)
    expect(col._def.uniqueNullsNotDistinct).toBeUndefined()
  })

  it("table-level uniques entry accepts nullsNotDistinct", () => {
    const t = defineTable(
      "members",
      { orgId: integer().notNull(), userId: integer().nullable() },
      {
        constraints: {
          uniques: [
            { name: "uq_members_org_user", columns: ["orgId", "userId"], nullsNotDistinct: true },
          ],
        },
      },
    )
    const u = t.constraints?.uniques?.[0]
    expect(u).toBeDefined()
    expect((u as { nullsNotDistinct?: boolean }).nullsNotDistinct).toBe(true)
  })
})

describe("UNIQUE NULLS NOT DISTINCT — diff materializes the flag", () => {
  it("column-level: ColumnDefinitionNode.uniqueNullsNotDistinct is set on CREATE TABLE", () => {
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().nullable().unique({ nullsNotDistinct: true }),
      }),
    }
    const nodes = diffSchemas({}, after)
    const create = nodes[0] as CreateTableNode
    const emailCol = create.columns.find((c) => c.name === "email")!
    expect(emailCol.unique).toBe(true)
    expect(emailCol.uniqueNullsNotDistinct).toBe(true)
  })

  it("column-level: legacy .unique() leaves uniqueNullsNotDistinct unset", () => {
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().unique(),
      }),
    }
    const nodes = diffSchemas({}, after)
    const create = nodes[0] as CreateTableNode
    const emailCol = create.columns.find((c) => c.name === "email")!
    expect(emailCol.unique).toBe(true)
    expect(emailCol.uniqueNullsNotDistinct).toBeUndefined()
  })

  it("table-level: UniqueConstraintNode.nullsNotDistinct is set on CREATE TABLE", () => {
    const after = {
      members: defineTable(
        "members",
        { orgId: integer().notNull(), userId: integer().nullable() },
        {
          constraints: {
            uniques: [
              {
                name: "uq_members_org_user",
                columns: ["orgId", "userId"],
                nullsNotDistinct: true,
              },
            ],
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
    expect(uq!.nullsNotDistinct).toBe(true)
  })

  it("table-level: legacy uniques entries leave nullsNotDistinct unset", () => {
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
    const nodes = diffSchemas({}, after)
    const create = nodes[0] as CreateTableNode
    const uq = create.constraints.find((c) => c.type === "unique_constraint") as
      | UniqueConstraintNode
      | undefined
    expect(uq).toBeDefined()
    expect(uq!.nullsNotDistinct).toBeUndefined()
  })

  it("toggling nullsNotDistinct on a named UNIQUE surfaces as drop + add", () => {
    const before = {
      members: defineTable(
        "members",
        { orgId: integer().notNull(), userId: integer().nullable() },
        {
          constraints: {
            uniques: [{ name: "uq_members", columns: ["orgId", "userId"] }],
          },
        },
      ),
    }
    const after = {
      members: defineTable(
        "members",
        { orgId: integer().notNull(), userId: integer().nullable() },
        {
          constraints: {
            uniques: [{ name: "uq_members", columns: ["orgId", "userId"], nullsNotDistinct: true }],
          },
        },
      ),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    // Expect at least one ALTER TABLE with a drop_constraint + add_constraint
    // pair (collapsed into one alter_table since both sides are PG-batchable).
    const alters = nodes.filter((n) => n.type === "alter_table") as AlterTableNode[]
    expect(alters.length).toBeGreaterThan(0)
    const kinds = alters.flatMap((a) => a.actions.map((act) => act.kind))
    expect(kinds).toContain("drop_constraint")
    expect(kinds).toContain("add_constraint")
  })

  it("identical schemas with nullsNotDistinct produce empty diff", () => {
    const schema = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().nullable().unique({ nullsNotDistinct: true }),
      }),
    }
    expect(diffSchemas(schema, schema)).toEqual([])
  })
})

describe("UNIQUE NULLS NOT DISTINCT — DDL printer", () => {
  it("PG column-level emits UNIQUE NULLS NOT DISTINCT", () => {
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().nullable().unique({ nullsNotDistinct: true }),
      }),
    }
    const [sql] = compileWith("pg", diffSchemas({}, after))
    expect(sql).toContain("UNIQUE NULLS NOT DISTINCT")
    // Sanity: the column definition is the one that carries the
    // modifier (column-level form), so it should appear before any
    // constraint list closer.
    expect(sql).toContain(`"email"`)
  })

  it("PG table-level emits UNIQUE NULLS NOT DISTINCT (cols)", () => {
    const after = {
      members: defineTable(
        "members",
        { orgId: integer().notNull(), userId: integer().nullable() },
        {
          constraints: {
            uniques: [
              {
                name: "uq_members_org_user",
                columns: ["orgId", "userId"],
                nullsNotDistinct: true,
              },
            ],
          },
        },
      ),
    }
    const [sql] = compileWith("pg", diffSchemas({}, after))
    expect(sql).toContain(`CONSTRAINT "uq_members_org_user" UNIQUE NULLS NOT DISTINCT`)
    expect(sql).toContain(`("orgId", "userId")`)
  })

  it("PG: regular UNIQUE without the flag is unchanged", () => {
    const after = {
      users: defineTable("users", {
        id: integer().primaryKey(),
        email: text().notNull().unique(),
      }),
    }
    const [sql] = compileWith("pg", diffSchemas({}, after))
    expect(sql).toContain("UNIQUE")
    expect(sql).not.toContain("NULLS NOT DISTINCT")
  })

  for (const { name } of DIALECTS) {
    if (name === "pg") continue
    it(`${name} column-level UNIQUE NULLS NOT DISTINCT throws UnsupportedDialectFeatureError`, () => {
      const after = {
        users: defineTable("users", {
          id: integer().primaryKey(),
          email: text().nullable().unique({ nullsNotDistinct: true }),
        }),
      }
      const nodes = diffSchemas({}, after)
      expect(() => compileWith(name, nodes)).toThrow(UnsupportedDialectFeatureError)
    })

    it(`${name} table-level UNIQUE NULLS NOT DISTINCT throws UnsupportedDialectFeatureError`, () => {
      const after = {
        members: defineTable(
          "members",
          { orgId: integer().notNull(), userId: integer().nullable() },
          {
            constraints: {
              uniques: [
                {
                  name: "uq_members_org_user",
                  columns: ["orgId", "userId"],
                  nullsNotDistinct: true,
                },
              ],
            },
          },
        ),
      }
      const nodes = diffSchemas({}, after)
      expect(() => compileWith(name, nodes)).toThrow(UnsupportedDialectFeatureError)
    })

    it(`${name} regular UNIQUE without the flag still works`, () => {
      const after = {
        users: defineTable("users", {
          id: integer().primaryKey(),
          email: text().notNull().unique(),
        }),
      }
      const [sql] = compileWith(name, diffSchemas({}, after))
      expect(sql).toContain("UNIQUE")
      expect(sql).not.toContain("NULLS NOT DISTINCT")
    })
  }
})
