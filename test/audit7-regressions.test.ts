import { describe, expect, it } from "vitest"

import { col, eq } from "../src/ast/expression.ts"
import type { JoinNode, OrderByNode, SelectNode } from "../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../src/ast/nodes.ts"
import { sql } from "../src/builder/sql.ts"
import { mssqlDialect } from "../src/dialect/mssql.ts"
import { mysqlDialect } from "../src/dialect/mysql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { MssqlPrinter } from "../src/printer/mssql.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #7 regressions", () => {
  describe("sql`` template sentinel collision", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })

    it("user text containing the old __PARAM_0__ substring is NOT substituted", () => {
      // The new null-byte sentinel (\x00SUMAK_PARAM_N\x00) is unreachable
      // via normal string input, so user-supplied tokens can't be mistaken
      // for our placeholder.
      const q = db
        .selectFrom("users")
        .where(() => sql<boolean>`comment = ${"see __PARAM_0__"}`)
        .select("id")
        .toSQL()
      // The user's string is a param value; the literal `__PARAM_0__`
      // inside it stays inside the param, not embedded into the SQL.
      expect(q.params).toContain("see __PARAM_0__")
      // And the SQL string itself has no stray __PARAM token — just $1.
      expect(q.sql).toContain("= $1")
      expect(q.sql).not.toContain("__PARAM")
    })
  })

  describe("DELETE without WHERE requires explicit .allRows()", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })

    it("throws a helpful error when .where() is omitted", () => {
      expect(() => db.deleteFrom("users").toSQL()).toThrow(/without a WHERE clause/)
    })

    it(".allRows() opts in and emits the full-table DELETE", () => {
      const q = db.deleteFrom("users").allRows().toSQL()
      expect(q.sql).toBe('DELETE FROM "users"')
    })

    it(".where(...).toSQL() still works without .allRows()", () => {
      const q = db
        .deleteFrom("users")
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).toContain("WHERE")
    })
  })

  describe("IN with null value split into (IN … OR IS NULL) for 3VL safety", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().nullable() } },
    })

    it("col.in([1, null, 2]) matches both values AND nulls", () => {
      const q = db
        .selectFrom("users")
        .where(({ id }) => id.in([1, null as any, 2]))
        .select("id")
        .toSQL()
      expect(q.sql).toContain("IN")
      expect(q.sql).toContain("IS NULL")
      // Non-null values are parameterized; null does not enter params.
      expect(q.params).toEqual([1, 2])
    })

    it("col.in([null]) — only null — reduces to `FALSE OR IS NULL`", () => {
      const q = db
        .selectFrom("users")
        .where(({ id }) => id.in([null as any]))
        .select("id")
        .toSQL()
      expect(q.sql).toContain("IS NULL")
      expect(q.params).toEqual([])
    })

    it("col.in([1, null], { negate: true }) → NOT IN (…) AND IS NOT NULL", () => {
      const q = db
        .selectFrom("users")
        .where(({ id }) => id.in([1, null as any], { negate: true }))
        .select("id")
        .toSQL()
      expect(q.sql).toContain("NOT IN")
      expect(q.sql).toContain("IS NOT NULL")
    })
  })

  describe("MySQL unsupported-feature guards", () => {
    it("DELETE ... RETURNING throws UnsupportedDialectFeatureError", () => {
      const db = sumak({
        dialect: mysqlDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      expect(() =>
        db
          .deleteFrom("users")
          .where(({ id }) => id.eq(1))
          .returning("id")
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("FULL JOIN throws UnsupportedDialectFeatureError", () => {
      const printer = new MysqlPrinter()
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("a"),
        columns: [{ type: "star" }],
        joins: [
          {
            type: "join",
            joinType: "FULL",
            table: tableRef("b"),
            on: eq(col("a_id"), col("b_id")),
          } satisfies JoinNode,
        ],
      }
      expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("NULLS FIRST / LAST in ORDER BY throws", () => {
      const printer = new MysqlPrinter()
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("t"),
        columns: [{ type: "star" }],
        orderBy: [{ expr: col("name"), direction: "ASC", nulls: "LAST" } satisfies OrderByNode],
      }
      expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
    })
  })

  describe("MSSQL guards", () => {
    it("OFFSET without ORDER BY throws a helpful error", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const q = db.selectFrom("users").select("id")
      expect(() => q.offset(10).toSQL()).toThrow(/requires ORDER BY/)
    })

    it("OFFSET + ORDER BY works", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const r = db.selectFrom("users").select("id").orderBy("id").offset(10).toSQL()
      expect(r.sql).toContain("ORDER BY")
      expect(r.sql).toContain("OFFSET")
    })

    it("NULLS FIRST / LAST throws on MSSQL too", () => {
      const printer = new MssqlPrinter()
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("t"),
        columns: [{ type: "star" }],
        orderBy: [{ expr: col("name"), direction: "ASC", nulls: "LAST" }],
      }
      expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
    })
  })

  describe("FILTER (WHERE …) aggregate guard on MySQL & MSSQL", () => {
    it("MySQL FILTER throws UnsupportedDialectFeatureError", async () => {
      const { count, filter, Col } = await import("../src/builder/eb.ts")
      const db = sumak({
        dialect: mysqlDialect(),
        tables: {
          users: { id: serial().primaryKey(), age: serial() },
        },
      })
      expect(() =>
        db
          .selectFrom("users")
          .select({ adults: filter(count(), new Col("age").gt(18)) })
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("MSSQL FILTER throws UnsupportedDialectFeatureError", async () => {
      const { count, filter, Col } = await import("../src/builder/eb.ts")
      const db = sumak({
        dialect: mssqlDialect(),
        tables: {
          users: { id: serial().primaryKey(), age: serial() },
        },
      })
      expect(() =>
        db
          .selectFrom("users")
          .select({ adults: filter(count(), new Col("age").gt(18)) })
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("PG FILTER still works (PG supports it natively)", async () => {
      const { count, filter, Col } = await import("../src/builder/eb.ts")
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), age: serial() } },
      })
      const r = db
        .selectFrom("users")
        .select({ adults: filter(count(), new Col("age").gt(18)) })
        .toSQL()
      expect(r.sql).toContain("FILTER (WHERE")
    })
  })
})
