import { describe, expect, it } from "vitest"

import { col, eq } from "../src/ast/expression.ts"
import type { ArrayExprNode, JoinNode, SelectNode } from "../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../src/ast/nodes.ts"
import { mssqlDialect } from "../src/dialect/mssql.ts"
import { mysqlDialect } from "../src/dialect/mysql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { SqlitePrinter } from "../src/printer/sqlite.ts"
import { integer, serial } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #12 regressions", () => {
  describe("ARRAY[...] dialect guards", () => {
    const arrNode: ArrayExprNode = {
      type: "array_expr",
      elements: [
        { type: "literal", value: 1 },
        { type: "literal", value: 2 },
      ],
    }
    const select: SelectNode = {
      ...createSelectNode(),
      from: tableRef("t"),
      columns: [arrNode],
    }

    it("PG emits ARRAY[1, 2]", () => {
      const r = new PgPrinter().print(select)
      expect(r.sql).toContain("ARRAY[")
    })

    it("MySQL throws", () => {
      expect(() => new MysqlPrinter().print(select)).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite throws", () => {
      expect(() => new SqlitePrinter().print(select)).toThrow(UnsupportedDialectFeatureError)
    })
  })

  describe("WITH RECURSIVE in DML (MySQL / SQLite)", () => {
    it("MySQL rejects recursive CTE on UPDATE", async () => {
      const { UpdateBuilder } = await import("../src/builder/update.ts")
      const { SelectBuilder } = await import("../src/builder/select.ts")
      const recursiveQuery = new SelectBuilder().columns("id").from("users").build()
      const node = new UpdateBuilder()
        .table("users")
        .with("cte", recursiveQuery, true)
        .set("id", { type: "literal", value: 1 })
        .build()
      expect(() => new MysqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite rejects recursive CTE on INSERT", async () => {
      const { InsertBuilder } = await import("../src/builder/insert.ts")
      const { SelectBuilder } = await import("../src/builder/select.ts")
      const recursiveQuery = new SelectBuilder().columns("id").from("users").build()
      const node = new InsertBuilder()
        .into("users")
        .columns("id")
        .values({ type: "literal", value: 1 })
        .with("cte", recursiveQuery, true)
        .build()
      expect(() => new SqlitePrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("PG allows recursive CTE on UPDATE", async () => {
      const { UpdateBuilder } = await import("../src/builder/update.ts")
      const { SelectBuilder } = await import("../src/builder/select.ts")
      const recursiveQuery = new SelectBuilder().columns("id").from("users").build()
      const node = new UpdateBuilder()
        .table("users")
        .with("cte", recursiveQuery, true)
        .set("id", { type: "literal", value: 1 })
        .build()
      const r = new PgPrinter().print(node)
      expect(r.sql).toContain("WITH RECURSIVE")
    })
  })

  describe("orderBy embedded direction detection", () => {
    it("SELECT orderBy('price DESC') throws with a helpful message", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { t: { id: serial().primaryKey(), price: integer() } },
      })
      expect(() =>
        db
          .selectFrom("t")
          .select("id")
          .orderBy("price DESC" as any),
      ).toThrow(/may not contain spaces/)
    })

    it("SELECT orderBy('price', 'DESC') works correctly", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { t: { id: serial().primaryKey(), price: integer() } },
      })
      const r = db.selectFrom("t").select("id").orderBy("id", "DESC").toSQL()
      expect(r.sql).toContain('ORDER BY "id" DESC')
    })
  })

  describe("JOIN without ON is rejected (CROSS JOIN must be explicit)", () => {
    const printer = new PgPrinter()

    it("INNER JOIN with no ON throws", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("a"),
        columns: [{ type: "star" }],
        joins: [
          {
            type: "join",
            joinType: "INNER",
            table: tableRef("b"),
          } satisfies JoinNode,
        ],
      }
      expect(() => printer.print(node)).toThrow(/requires an ON condition/)
    })

    it("CROSS JOIN without ON is valid", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("a"),
        columns: [{ type: "star" }],
        joins: [
          {
            type: "join",
            joinType: "CROSS",
            table: tableRef("b"),
          } satisfies JoinNode,
        ],
      }
      const r = printer.print(node)
      expect(r.sql).toContain("CROSS JOIN")
    })

    it("INNER JOIN with ON is valid", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("a"),
        columns: [{ type: "star" }],
        joins: [
          {
            type: "join",
            joinType: "INNER",
            table: tableRef("b"),
            on: eq(col("id", "a"), col("a_id", "b")),
          } satisfies JoinNode,
        ],
      }
      const r = printer.print(node)
      expect(r.sql).toContain("INNER JOIN")
      expect(r.sql).toContain("ON")
    })
  })

  describe("distinctFrom on PG keeps IS DISTINCT FROM", () => {
    it("MSSQL still throws", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      expect(() =>
        db
          .selectFrom("users")
          .where(({ age }) => age.distinctFrom(null))
          .select("id")
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("MySQL rewrites to <=> (guarded by prior audit)", () => {
      const db = sumak({
        dialect: mysqlDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      const r = db
        .selectFrom("users")
        .where(({ age }) => age.distinctFrom(null, { negate: true }))
        .select("id")
        .toSQL()
      expect(r.sql).toContain("<=>")
    })

    it("SQLite uses IS / IS NOT (guarded by prior audit)", () => {
      const db = sumak({
        dialect: sqliteDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      const r = db
        .selectFrom("users")
        .where(({ age }) => age.distinctFrom(null))
        .select("id")
        .toSQL()
      expect(r.sql).toContain("IS NOT")
    })
  })
})
