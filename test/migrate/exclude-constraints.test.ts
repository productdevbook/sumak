import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type {
  AlterTableNode,
  CreateTableNode,
  ExcludeConstraintNode,
} from "../../src/ast/ddl-nodes.ts"
import { sql } from "../../src/builder/sql.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { SecurityError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { diffSchemas } from "../../src/migrate/diff.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { ColumnBuilder, integer, serial, text } from "../../src/schema/column.ts"
import { defineTable } from "../../src/schema/table.ts"
import { sumak } from "../../src/sumak.ts"
import type { SQLDialect } from "../../src/types.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

// PostgreSQL EXCLUDE constraint — a table-level generalisation of
// UNIQUE where each element pairs a column/expression with a
// commutative operator that must NOT hold between any two rows. The
// flagship case is range-overlap exclusion: a booking system that
// guarantees no two reservations for the same room can overlap in
// time. The constraint is backed by a GiST / SP-GiST / btree index;
// `gist` is the default and the only access method that supports the
// `&&` range-overlap operator.
//
// Without EXCLUDE, the same invariant has to be enforced in
// application code with all the race conditions that come with it.

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

// `tstzrange` is PG-specific; the ColumnBuilder constructor accepts
// the raw data-type string, which is the path the schema layer takes
// for any vendor-specific type.
function tstzrange(): ColumnBuilder<string, string, string> {
  return new ColumnBuilder("tstzrange")
}

describe("EXCLUDE constraint — schema DSL", () => {
  it("preserves elements + method on the table definition", () => {
    const t = defineTable(
      "bookings",
      {
        id: serial().primaryKey(),
        room: text().notNull(),
        during: tstzrange().notNull(),
      },
      {
        constraints: {
          excludes: [
            {
              name: "no_overlap",
              method: "gist",
              elements: [
                { expr: "room", operator: "=" },
                { expr: "during", operator: "&&" },
              ],
            },
          ],
        },
      },
    )
    expect(t.constraints?.excludes?.[0]?.name).toBe("no_overlap")
    expect(t.constraints?.excludes?.[0]?.method).toBe("gist")
    expect(t.constraints?.excludes?.[0]?.elements).toHaveLength(2)
    expect(t.constraints?.excludes?.[0]?.elements[0]).toEqual({
      expr: "room",
      operator: "=",
    })
    expect(t.constraints?.excludes?.[0]?.elements[1]).toEqual({
      expr: "during",
      operator: "&&",
    })
  })

  it("preserves WHERE predicate (raw SQL form)", () => {
    const t = defineTable(
      "priorities",
      { id: serial().primaryKey(), priority: integer().notNull(), active: integer().notNull() },
      {
        constraints: {
          excludes: [
            {
              name: "only_one_active_per_priority",
              elements: [{ expr: "priority", operator: "=" }],
              where: "active = 1",
            },
          ],
        },
      },
    )
    expect(t.constraints?.excludes?.[0]?.where).toBe("active = 1")
  })
})

describe("EXCLUDE constraint — diff materialization", () => {
  it("materializes an ExcludeConstraintNode on a new table", () => {
    const after = {
      bookings: defineTable(
        "bookings",
        {
          id: serial().primaryKey(),
          room: text().notNull(),
          during: tstzrange().notNull(),
        },
        {
          constraints: {
            excludes: [
              {
                name: "no_overlap",
                method: "gist",
                elements: [
                  { expr: "room", operator: "=" },
                  { expr: "during", operator: "&&" },
                ],
              },
            ],
          },
        },
      ),
    }
    const nodes = diffSchemas({}, after)
    const create = nodes.find((n) => n.type === "create_table") as CreateTableNode | undefined
    expect(create).toBeDefined()
    const ex = create!.constraints.find((c) => c.type === "exclude_constraint") as
      | ExcludeConstraintNode
      | undefined
    expect(ex).toBeDefined()
    expect(ex!.name).toBe("no_overlap")
    expect(ex!.method).toBe("gist")
    expect(ex!.elements).toHaveLength(2)
    expect(ex!.elements[0]?.operator).toBe("=")
    expect(ex!.elements[1]?.operator).toBe("&&")
    // Bare-string `expr` lowers to a `column_ref` node.
    expect(ex!.elements[0]?.expr.type).toBe("column_ref")
  })

  it("identical exclude constraints produce no diff", () => {
    const schema = {
      bookings: defineTable(
        "bookings",
        { id: serial().primaryKey(), room: text().notNull(), during: tstzrange().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "no_overlap",
                method: "gist",
                elements: [
                  { expr: "room", operator: "=" },
                  { expr: "during", operator: "&&" },
                ],
              },
            ],
          },
        },
      ),
    }
    expect(diffSchemas(schema, schema)).toEqual([])
  })

  it("changing the method surfaces as drop + add", () => {
    const before = {
      t: defineTable(
        "t",
        { id: serial().primaryKey(), name: text().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "ex_t",
                method: "gist",
                elements: [{ expr: "name", operator: "=" }],
              },
            ],
          },
        },
      ),
    }
    const after = {
      t: defineTable(
        "t",
        { id: serial().primaryKey(), name: text().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "ex_t",
                method: "btree",
                elements: [{ expr: "name", operator: "=" }],
              },
            ],
          },
        },
      ),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const alters = nodes.filter((n) => n.type === "alter_table") as AlterTableNode[]
    const allActions = alters.flatMap((a) => a.actions.map((x) => x.kind))
    expect(allActions).toContain("drop_constraint")
    expect(allActions).toContain("add_constraint")
  })

  it("changing the elements surfaces as drop + add", () => {
    const before = {
      bookings: defineTable(
        "bookings",
        { id: serial().primaryKey(), room: text().notNull(), during: tstzrange().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "no_overlap",
                elements: [{ expr: "during", operator: "&&" }],
              },
            ],
          },
        },
      ),
    }
    const after = {
      bookings: defineTable(
        "bookings",
        { id: serial().primaryKey(), room: text().notNull(), during: tstzrange().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "no_overlap",
                elements: [
                  { expr: "room", operator: "=" },
                  { expr: "during", operator: "&&" },
                ],
              },
            ],
          },
        },
      ),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const alters = nodes.filter((n) => n.type === "alter_table") as AlterTableNode[]
    const allActions = alters.flatMap((a) => a.actions.map((x) => x.kind))
    expect(allActions).toContain("drop_constraint")
    expect(allActions).toContain("add_constraint")
  })

  it("changing the WHERE predicate surfaces as drop + add", () => {
    const before = {
      orders: defineTable(
        "orders",
        { id: serial().primaryKey(), priority: integer().notNull(), active: integer().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "only_one_per_prio",
                elements: [{ expr: "priority", operator: "=" }],
                where: "active = 1",
              },
            ],
          },
        },
      ),
    }
    const after = {
      orders: defineTable(
        "orders",
        { id: serial().primaryKey(), priority: integer().notNull(), active: integer().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "only_one_per_prio",
                elements: [{ expr: "priority", operator: "=" }],
                where: "active = 2",
              },
            ],
          },
        },
      ),
    }
    const nodes = diffSchemas(before, after, { allowDestructive: true })
    const alters = nodes.filter((n) => n.type === "alter_table") as AlterTableNode[]
    const allActions = alters.flatMap((a) => a.actions.map((x) => x.kind))
    expect(allActions).toContain("drop_constraint")
    expect(allActions).toContain("add_constraint")
  })

  it("Expression-form WHERE survives through diff", () => {
    const after = {
      orders: defineTable(
        "orders",
        { id: serial().primaryKey(), priority: integer().notNull(), active: integer().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "only_one_active",
                elements: [{ expr: "priority", operator: "=" }],
                where: sql<boolean>`active = 1`,
              },
            ],
          },
        },
      ),
    }
    const nodes = diffSchemas({}, after)
    const create = nodes.find((n) => n.type === "create_table") as CreateTableNode
    const ex = create.constraints.find((c) => c.type === "exclude_constraint") as
      | ExcludeConstraintNode
      | undefined
    expect(ex?.where).toBeDefined()
  })
})

describe("EXCLUDE constraint — DDL printer", () => {
  it("PG emits canonical booking-system example", () => {
    const after = {
      bookings: defineTable(
        "bookings",
        {
          id: serial().primaryKey(),
          room: text().notNull(),
          during: tstzrange().notNull(),
        },
        {
          constraints: {
            excludes: [
              {
                name: "no_overlap",
                method: "gist",
                elements: [
                  { expr: "room", operator: "=" },
                  { expr: "during", operator: "&&" },
                ],
              },
            ],
          },
        },
      ),
    }
    const [sqlStr] = compileWith("pg", diffSchemas({}, after))
    expect(sqlStr).toContain(`CONSTRAINT "no_overlap"`)
    expect(sqlStr).toContain("EXCLUDE USING gist")
    expect(sqlStr).toContain(`"room" WITH =`)
    expect(sqlStr).toContain(`"during" WITH &&`)
  })

  it("PG emits partial exclude with WHERE predicate", () => {
    const after = {
      orders: defineTable(
        "orders",
        { id: serial().primaryKey(), priority: integer().notNull(), active: integer().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "one_active_per_prio",
                elements: [{ expr: "priority", operator: "=" }],
                where: "active = 1",
              },
            ],
          },
        },
      ),
    }
    const [sqlStr] = compileWith("pg", diffSchemas({}, after))
    expect(sqlStr).toContain("EXCLUDE USING gist")
    expect(sqlStr).toContain(`"priority" WITH =`)
    expect(sqlStr).toContain("WHERE")
    expect(sqlStr).toContain("active = 1")
  })

  it("PG defaults method to gist when unset", () => {
    const after = {
      t: defineTable(
        "t",
        { id: serial().primaryKey(), tag: text().notNull() },
        {
          constraints: {
            excludes: [
              {
                name: "ex_default_method",
                // No method — printer defaults to gist.
                elements: [{ expr: "tag", operator: "=" }],
              },
            ],
          },
        },
      ),
    }
    const [sqlStr] = compileWith("pg", diffSchemas({}, after))
    expect(sqlStr).toContain("EXCLUDE USING gist")
  })

  it("PG emits unnamed exclude without CONSTRAINT prefix", () => {
    const after = {
      t: defineTable(
        "t",
        { id: serial().primaryKey(), tag: text().notNull() },
        {
          constraints: {
            excludes: [{ elements: [{ expr: "tag", operator: "=" }] }],
          },
        },
      ),
    }
    const [sqlStr] = compileWith("pg", diffSchemas({}, after))
    expect(sqlStr).toContain("EXCLUDE USING gist")
    // No leading CONSTRAINT keyword when the user didn't name it.
    expect(sqlStr).not.toMatch(/CONSTRAINT\s*"\s*"/)
  })

  it("MySQL throws UnsupportedDialectFeatureError", () => {
    const after = {
      bookings: defineTable(
        "bookings",
        { id: serial().primaryKey(), room: text().notNull() },
        {
          constraints: {
            excludes: [
              {
                elements: [{ expr: "room", operator: "=" }],
              },
            ],
          },
        },
      ),
    }
    const nodes = diffSchemas({}, after)
    expect(() => compileWith("mysql", nodes)).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite throws UnsupportedDialectFeatureError", () => {
    const after = {
      bookings: defineTable(
        "bookings",
        { id: serial().primaryKey(), room: text().notNull() },
        {
          constraints: {
            excludes: [{ elements: [{ expr: "room", operator: "=" }] }],
          },
        },
      ),
    }
    const nodes = diffSchemas({}, after)
    expect(() => compileWith("sqlite", nodes)).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL throws UnsupportedDialectFeatureError", () => {
    const after = {
      bookings: defineTable(
        "bookings",
        { id: serial().primaryKey(), room: text().notNull() },
        {
          constraints: {
            excludes: [{ elements: [{ expr: "room", operator: "=" }] }],
          },
        },
      ),
    }
    const nodes = diffSchemas({}, after)
    expect(() => compileWith("mssql", nodes)).toThrow(UnsupportedDialectFeatureError)
  })

  it("rejects an unsafe operator token at print time", () => {
    // A hand-crafted AST with a bogus operator should be refused. The
    // diff path never produces this — it's the safety net for the
    // direct-AST surface.
    const dummy = {
      type: "create_table",
      table: { type: "table_ref", name: "t" },
      columns: [{ type: "column_definition", name: "id", dataType: "INTEGER", primaryKey: true }],
      constraints: [
        {
          type: "exclude_constraint",
          elements: [
            {
              expr: { type: "column_ref", column: "x" },
              operator: "='; DROP TABLE",
            },
          ],
        },
      ],
    }
    expect(() => compileWith("pg", [dummy])).toThrow(SecurityError)
  })

  it("rejects an unsafe method name at print time", () => {
    const dummy = {
      type: "create_table",
      table: { type: "table_ref", name: "t" },
      columns: [{ type: "column_definition", name: "id", dataType: "INTEGER", primaryKey: true }],
      constraints: [
        {
          type: "exclude_constraint",
          method: "gist; DROP TABLE x",
          elements: [
            {
              expr: { type: "column_ref", column: "x" },
              operator: "=",
            },
          ],
        },
      ],
    }
    expect(() => compileWith("pg", [dummy])).toThrow()
  })
})

describe("EXCLUDE constraint — pglite roundtrip", () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
  })

  afterAll(async () => {
    await pg?.close()
  })

  it("rejects overlapping ranges and accepts disjoint ones", async () => {
    const driver = pgliteDriver(pg)
    // Single-element exclude (`during WITH &&`) — works on native GiST
    // out of the box because `tstzrange` is a built-in range type with
    // GiST support; we don't need the `btree_gist` extension that
    // pglite doesn't ship. The full booking pattern uses the composite
    // form (room WITH =, during WITH &&) — exercised by the printer +
    // diff tests above; the integration test here is the end-to-end
    // proof that "the constraint is actually enforced by the engine".
    const schema = {
      ex_bookings: defineTable(
        "ex_bookings",
        {
          id: serial().primaryKey(),
          during: tstzrange().notNull(),
        },
        {
          constraints: {
            excludes: [
              {
                name: "ex_bookings_no_overlap",
                method: "gist",
                elements: [{ expr: "during", operator: "&&" }],
              },
            ],
          },
        },
      ),
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)

    // Insert a baseline reservation from 10:00 to 12:00.
    await pg.query(
      `INSERT INTO "ex_bookings"("during") VALUES (tstzrange('2030-01-01 10:00+00','2030-01-01 12:00+00'))`,
    )

    // Overlapping interval — must fail with a constraint violation
    // citing the constraint name (or just "exclude").
    await expect(
      pg.query(
        `INSERT INTO "ex_bookings"("during") VALUES (tstzrange('2030-01-01 11:00+00','2030-01-01 13:00+00'))`,
      ),
    ).rejects.toThrow(/ex_bookings_no_overlap|exclude|conflicting/i)

    // Disjoint interval — fine.
    await pg.query(
      `INSERT INTO "ex_bookings"("during") VALUES (tstzrange('2030-01-01 13:00+00','2030-01-01 14:00+00'))`,
    )
  })
})
