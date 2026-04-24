import { describe, expect, it } from "vitest"

import { sql } from "../../src/builder/sql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { diffSchemas } from "../../src/migrate/diff.ts"
import { integer, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// Column-level CHECK constraints. The builder captures the expression
// on `ColumnDef.check` — either as a raw SQL fragment (schema-design
// time; never user input) or as a pre-built Expression AST. The diff
// engine lowers it into the CREATE TABLE payload, and the DDL printer
// emits `CHECK (...)` on the column.

describe("ColumnBuilder.check", () => {
  it("stores raw SQL form on ColumnDef", () => {
    const col = integer().check("age >= 0")
    expect(col._def.check).toEqual({ sql: "age >= 0" })
  })

  it("stores named check", () => {
    const col = integer().check("age >= 0", { name: "ck_age_non_negative" })
    expect(col._def.check).toEqual({ name: "ck_age_non_negative", sql: "age >= 0" })
  })

  it("accepts Expression<boolean> and retains the AST node", () => {
    const col = integer().check(sql<boolean>`age >= 0`)
    expect(col._def.check?.node).toBeTruthy()
    expect(col._def.check?.sql).toBe("")
  })

  it("survives a .notNull() chain without dropping the check", () => {
    const col = integer().check("age >= 0").notNull()
    expect(col._def.check).toEqual({ sql: "age >= 0" })
    expect(col._def.isNotNull).toBe(true)
  })
})

describe("diffSchemas — column CHECK", () => {
  function compile(nodes: { type: string }[]): string[] {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    return nodes.map(
      (n) => (db.compileDDL(n as Parameters<typeof db.compileDDL>[0]) as { sql: string }).sql,
    )
  }

  it("emits CHECK clause on CREATE TABLE for raw-SQL form", () => {
    const after = {
      users: {
        id: integer().primaryKey(),
        age: integer().check("age >= 0"),
      },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toContain("CHECK")
    expect(ddl).toContain("age >= 0")
  })

  it("preserves Expression-form checks with proper quoting", () => {
    const after = {
      users: {
        id: integer().primaryKey(),
        name: text().check(sql<boolean>`char_length(${sql.ref("name")}) > 0`),
      },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toContain("CHECK")
    expect(ddl).toContain(`"name"`) // PG identifier quoting applied
    expect(ddl).toContain("char_length")
  })
})
