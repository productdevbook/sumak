import { describe, expect, it } from "vitest"

import { sql } from "../../src/builder/sql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { diffSchemas } from "../../src/migrate/diff.ts"
import { boolean, integer, text, timestamp, uuid } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// Expression defaults + literal defaults + GENERATED columns: three
// separate paths through ColumnDef → ColumnDefinitionNode. Every path
// needs to land in the CREATE TABLE SQL with the right syntax.

function compile(nodes: { type: string }[]): string[] {
  const db = sumak({ dialect: pgDialect(), tables: {} })
  return nodes.map(
    (n) => (db.compileDDL(n as Parameters<typeof db.compileDDL>[0]) as { sql: string }).sql,
  )
}

describe("ColumnBuilder.defaultTo — literal form", () => {
  it("stores boolean literal on ColumnDef", () => {
    const col = boolean().defaultTo(true)
    expect(col._def.hasDefault).toBe(true)
    expect(col._def.defaultValue).toBe(true)
    expect(col._def.defaultExpression).toBeUndefined()
  })

  it("emits DEFAULT true in CREATE TABLE", () => {
    const after = {
      users: { id: integer().primaryKey(), active: boolean().defaultTo(true) },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toMatch(/DEFAULT/)
    expect(ddl).toMatch(/TRUE/i)
  })

  it("string default flows through as a quoted literal", () => {
    const after = {
      users: { id: integer().primaryKey(), role: text().defaultTo("member") },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toMatch(/DEFAULT\s+'member'/)
  })

  it("numeric default flows through as a bare number", () => {
    const after = {
      users: { id: integer().primaryKey(), score: integer().defaultTo(0) },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toMatch(/DEFAULT\s+0/)
  })
})

describe("ColumnBuilder.defaultTo — expression form", () => {
  it("stores the Expression node on ColumnDef.defaultExpression", () => {
    const col = timestamp().defaultTo(sql`CURRENT_TIMESTAMP`)
    expect(col._def.hasDefault).toBe(true)
    expect(col._def.defaultExpression).toBeDefined()
    expect(col._def.defaultValue).toBeUndefined()
  })

  it("CURRENT_TIMESTAMP survives into CREATE TABLE SQL", () => {
    const after = {
      events: {
        id: integer().primaryKey(),
        created_at: timestamp().defaultTo(sql`CURRENT_TIMESTAMP`),
      },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toMatch(/DEFAULT\s+CURRENT_TIMESTAMP/i)
  })

  it("gen_random_uuid() (PG) comes through verbatim for uuid columns", () => {
    const after = {
      sessions: {
        id: uuid()
          .defaultTo(sql`gen_random_uuid()`)
          .primaryKey(),
        created_at: timestamp().defaultTo(sql`CURRENT_TIMESTAMP`),
      },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toMatch(/gen_random_uuid/)
    expect(ddl).toMatch(/CURRENT_TIMESTAMP/i)
  })
})

describe("ColumnBuilder.generatedAlwaysAs", () => {
  it("stores generated descriptor on ColumnDef", () => {
    const col = integer().generatedAlwaysAs(sql`a + b`, { stored: true })
    expect(col._def.isGenerated).toBe(true)
    expect(col._def.generated?.stored).toBe(true)
    expect(col._def.generated?.expression).toBeDefined()
  })

  it("emits GENERATED ALWAYS AS (...) STORED in CREATE TABLE", () => {
    const after = {
      boxes: {
        id: integer().primaryKey(),
        width: integer().notNull(),
        height: integer().notNull(),
        area: integer().generatedAlwaysAs(sql`width * height`, { stored: true }),
      },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toMatch(/GENERATED ALWAYS AS/)
    expect(ddl).toMatch(/STORED/)
    expect(ddl).toMatch(/width/)
    expect(ddl).toMatch(/height/)
  })

  it("omitting stored flag omits the STORED keyword", () => {
    const after = {
      boxes: {
        id: integer().primaryKey(),
        label: text().notNull(),
        upper_label: text().generatedAlwaysAs(sql`UPPER(label)`),
      },
    }
    const [ddl] = compile(diffSchemas({}, after))
    expect(ddl).toMatch(/GENERATED ALWAYS AS/)
    expect(ddl).not.toMatch(/STORED/)
  })
})
