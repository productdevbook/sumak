import { describe, expect, it } from "vitest"

import { col, eq } from "../src/ast/expression.ts"
import type { ExplainNode, SelectNode } from "../src/ast/nodes.ts"
import { createSelectNode } from "../src/ast/nodes.ts"
import { DeleteBuilder } from "../src/builder/delete.ts"
import { SelectBuilder } from "../src/builder/select.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { MssqlPrinter } from "../src/printer/mssql.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { SqlitePrinter } from "../src/printer/sqlite.ts"

describe("Audit #21 regressions", () => {
  describe("MSSQL DELETE with JOIN uses correct multi-table syntax", () => {
    it("emits `DELETE <target> FROM <target> <joins>`", () => {
      const node = new DeleteBuilder()
        .from("users")
        .innerJoin("orders", eq(col("id", "users"), col("user_id", "orders")))
        .build()
      const r = new MssqlPrinter().print(node)
      expect(r.sql).toMatch(/^DELETE \[users\] FROM \[users\] INNER JOIN/)
      expect(r.sql).not.toContain("DELETE FROM [users] INNER JOIN")
    })

    it("aliased target: DELETE [o] FROM [orders] AS [o]", () => {
      const node = new DeleteBuilder()
        .from({ type: "table_ref", name: "orders", alias: "o" })
        .innerJoin("users", eq(col("id", "users"), col("user_id", "o")))
        .build()
      const r = new MssqlPrinter().print(node)
      expect(r.sql).toMatch(/^DELETE \[o\] FROM \[orders\] AS \[o\] INNER JOIN/)
    })

    it("rejects `USING` on MSSQL (pg-only syntax)", () => {
      const node = new DeleteBuilder().from("orders").using("users").build()
      expect(() => new MssqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })
  })

  describe("MySQL rejects PG-only lock modes", () => {
    it("forNoKeyUpdate throws", () => {
      const node = new SelectBuilder().columns("*").from("users").forNoKeyUpdate().build()
      expect(() => new MysqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("forKeyShare throws", () => {
      const node = new SelectBuilder().columns("*").from("users").forKeyShare().build()
      expect(() => new MysqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("forUpdate still works", () => {
      const node = new SelectBuilder().columns("*").from("users").forUpdate().build()
      const r = new MysqlPrinter().print(node)
      expect(r.sql).toContain("FOR UPDATE")
    })

    it("forShare still works", () => {
      const node = new SelectBuilder().columns("*").from("users").forShare().build()
      const r = new MysqlPrinter().print(node)
      expect(r.sql).toContain("FOR SHARE")
    })
  })

  describe("EXPLAIN dialect overrides", () => {
    const stmt: SelectNode = {
      ...createSelectNode(),
      columns: [{ type: "star" }],
      from: { type: "table_ref", name: "users" },
    }

    it("MSSQL EXPLAIN throws (no MSSQL equivalent)", () => {
      const node: ExplainNode = { type: "explain", statement: stmt }
      expect(() => new MssqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite EXPLAIN ANALYZE throws", () => {
      const node: ExplainNode = { type: "explain", statement: stmt, analyze: true }
      expect(() => new SqlitePrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite EXPLAIN (FORMAT JSON) throws", () => {
      const node: ExplainNode = { type: "explain", statement: stmt, format: "JSON" }
      expect(() => new SqlitePrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite bare EXPLAIN still works (opcodes)", () => {
      const node: ExplainNode = { type: "explain", statement: stmt }
      const r = new SqlitePrinter().print(node)
      expect(r.sql).toMatch(/^EXPLAIN /)
    })

    it("MySQL rewrites (FORMAT JSON) to FORMAT=JSON (no parens, equals)", () => {
      const node: ExplainNode = { type: "explain", statement: stmt, format: "JSON" }
      const r = new MysqlPrinter().print(node)
      expect(r.sql).toContain("FORMAT=JSON")
      expect(r.sql).not.toContain("(FORMAT JSON)")
    })

    it("MySQL rejects YAML / XML formats", () => {
      const yamlNode: ExplainNode = { type: "explain", statement: stmt, format: "YAML" }
      expect(() => new MysqlPrinter().print(yamlNode)).toThrow(UnsupportedDialectFeatureError)
      const xmlNode: ExplainNode = { type: "explain", statement: stmt, format: "XML" }
      expect(() => new MysqlPrinter().print(xmlNode)).toThrow(UnsupportedDialectFeatureError)
    })
  })
})
