import { describe, expect, it } from "vitest"

import { col, param, star } from "../../src/ast/expression.ts"
import type { FullTextSearchNode, SelectNode } from "../../src/ast/nodes.ts"
import { createSelectNode } from "../../src/ast/nodes.ts"
import { MssqlPrinter } from "../../src/printer/mssql.ts"
import { MysqlPrinter } from "../../src/printer/mysql.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { SqlitePrinter } from "../../src/printer/sqlite.ts"

function ftsNode(overrides?: Partial<FullTextSearchNode>): FullTextSearchNode {
  return {
    type: "full_text_search",
    columns: [col("name")],
    query: param(0, "alice"),
    ...overrides,
  }
}

function selectWithFts(fts: FullTextSearchNode): SelectNode {
  return {
    ...createSelectNode(),
    columns: [star()],
    from: { type: "table_ref", name: "users" },
    where: fts,
  }
}

describe("Full-Text Search — dialect-specific printing", () => {
  describe("PostgreSQL", () => {
    it("prints to_tsvector @@ to_tsquery", () => {
      const r = new PgPrinter().print(selectWithFts(ftsNode()))
      expect(r.sql).toContain("to_tsvector")
      expect(r.sql).toContain("@@")
      expect(r.sql).toContain("to_tsquery")
      expect(r.params).toEqual(["alice"])
    })

    it("prints with language config", () => {
      const r = new PgPrinter().print(selectWithFts(ftsNode({ language: "english" })))
      expect(r.sql).toContain("'english'")
      expect(r.sql).toContain("to_tsvector")
    })
  })

  describe("MySQL", () => {
    it("prints MATCH AGAINST", () => {
      const r = new MysqlPrinter().print(selectWithFts(ftsNode()))
      expect(r.sql).toContain("MATCH(")
      expect(r.sql).toContain("AGAINST(")
      expect(r.params).toEqual(["alice"])
    })

    it("prints BOOLEAN MODE", () => {
      const r = new MysqlPrinter().print(selectWithFts(ftsNode({ mode: "boolean" })))
      expect(r.sql).toContain("IN BOOLEAN MODE")
    })

    it("prints NATURAL LANGUAGE MODE", () => {
      const r = new MysqlPrinter().print(selectWithFts(ftsNode({ mode: "natural" })))
      expect(r.sql).toContain("IN NATURAL LANGUAGE MODE")
    })

    it("prints WITH QUERY EXPANSION", () => {
      const r = new MysqlPrinter().print(selectWithFts(ftsNode({ mode: "expansion" })))
      expect(r.sql).toContain("WITH QUERY EXPANSION")
    })
  })

  describe("SQLite", () => {
    it("prints FTS5 MATCH", () => {
      const r = new SqlitePrinter().print(selectWithFts(ftsNode()))
      expect(r.sql).toContain("MATCH")
      expect(r.params).toEqual(["alice"])
    })
  })

  describe("MSSQL", () => {
    it("prints CONTAINS by default", () => {
      const r = new MssqlPrinter().print(selectWithFts(ftsNode()))
      expect(r.sql).toContain("CONTAINS(")
      expect(r.params).toEqual(["alice"])
    })

    it("prints FREETEXT for natural mode", () => {
      const r = new MssqlPrinter().print(selectWithFts(ftsNode({ mode: "natural" })))
      expect(r.sql).toContain("FREETEXT(")
    })

    it("prints CONTAINS for boolean mode", () => {
      const r = new MssqlPrinter().print(selectWithFts(ftsNode({ mode: "boolean" })))
      expect(r.sql).toContain("CONTAINS(")
    })
  })
})
