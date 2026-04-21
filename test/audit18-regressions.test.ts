import { describe, expect, it } from "vitest"

import type { BetweenNode, FunctionCallNode, JsonAccessNode, SelectNode } from "../src/ast/nodes.ts"
import { createSelectNode } from "../src/ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { MssqlPrinter } from "../src/printer/mssql.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { SqlitePrinter } from "../src/printer/sqlite.ts"

const selectOf = (expr: SelectNode["columns"][0]): SelectNode => ({
  ...createSelectNode(),
  columns: [expr],
  from: { type: "table_ref", name: "t" },
})

describe("Audit #18 regressions", () => {
  describe("MSSQL rejects all JSON path operators (no ->, ->>, #>, #>>)", () => {
    it("JsonAccess throws UnsupportedDialectFeatureError", () => {
      const node = selectOf({
        type: "json_access",
        expr: { type: "column_ref", column: "data" },
        operator: "->>",
        path: "name",
      } as JsonAccessNode)
      expect(() => new MssqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })
  })

  describe("MySQL/SQLite reject #> and #>> (PG-only path operators)", () => {
    it("MySQL #>> throws", () => {
      const node = selectOf({
        type: "json_access",
        expr: { type: "column_ref", column: "data" },
        operator: "#>>",
        path: "a.b",
      } as JsonAccessNode)
      expect(() => new MysqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite #> throws", () => {
      const node = selectOf({
        type: "json_access",
        expr: { type: "column_ref", column: "data" },
        operator: "#>",
        path: "a.b",
      } as JsonAccessNode)
      expect(() => new SqlitePrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("MySQL -> still works (dialect-supported)", () => {
      const node = selectOf({
        type: "json_access",
        expr: { type: "column_ref", column: "data" },
        operator: "->",
        path: "name",
      } as JsonAccessNode)
      const r = new MysqlPrinter().print(node)
      expect(r.sql).toContain("->")
    })

    it("PG #>> still works (dialect-native)", () => {
      const node = selectOf({
        type: "json_access",
        expr: { type: "column_ref", column: "data" },
        operator: "#>>",
        path: "a.b",
      } as JsonAccessNode)
      const r = new PgPrinter().print(node)
      expect(r.sql).toContain("#>>")
    })
  })

  describe("BETWEEN SYMMETRIC is PG-only", () => {
    const between: BetweenNode = {
      type: "between",
      expr: { type: "column_ref", column: "age" },
      low: { type: "literal", value: 18 },
      high: { type: "literal", value: 65 },
      negated: false,
      symmetric: true,
    }
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [{ type: "star" }],
      from: { type: "table_ref", name: "t" },
      where: between,
    }

    it("MySQL throws", () => {
      expect(() => new MysqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite throws", () => {
      expect(() => new SqlitePrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("MSSQL throws", () => {
      expect(() => new MssqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("PG still emits SYMMETRIC", () => {
      const r = new PgPrinter().print(node)
      expect(r.sql).toContain("BETWEEN SYMMETRIC")
    })
  })

  describe("GREATEST / LEAST rewrites on SQLite", () => {
    const greatest: FunctionCallNode = {
      type: "function_call",
      name: "GREATEST",
      args: [
        { type: "column_ref", column: "a" },
        { type: "column_ref", column: "b" },
      ],
    }
    const least: FunctionCallNode = {
      type: "function_call",
      name: "LEAST",
      args: [
        { type: "column_ref", column: "a" },
        { type: "column_ref", column: "b" },
      ],
    }

    it("SQLite GREATEST → MAX(a, b)", () => {
      const r = new SqlitePrinter().print(selectOf(greatest))
      expect(r.sql).toContain("MAX(")
      expect(r.sql).not.toContain("GREATEST")
    })

    it("SQLite LEAST → MIN(a, b)", () => {
      const r = new SqlitePrinter().print(selectOf(least))
      expect(r.sql).toContain("MIN(")
      expect(r.sql).not.toContain("LEAST")
    })

    it("PG GREATEST stays GREATEST (native)", () => {
      const r = new PgPrinter().print(selectOf(greatest))
      expect(r.sql).toContain("GREATEST(")
    })
  })
})
