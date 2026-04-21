import { describe, expect, it } from "vitest"

import type { InsertNode, JsonAccessNode, SelectNode } from "../src/ast/nodes.ts"
import { createInsertNode, createSelectNode } from "../src/ast/nodes.ts"
import { coalesce } from "../src/builder/eb.ts"
import { MssqlPrinter } from "../src/printer/mssql.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { SqlitePrinter } from "../src/printer/sqlite.ts"

const selectJsonAccess = (op: "->" | "->>", path: string): SelectNode => ({
  ...createSelectNode(),
  columns: [
    {
      type: "json_access",
      expr: { type: "column_ref", column: "data" },
      operator: op,
      path,
    } as JsonAccessNode,
  ],
  from: { type: "table_ref", name: "t" },
})

describe("Audit #24 regressions", () => {
  describe("coalesce() requires at least one argument", () => {
    it("coalesce() with zero args throws at builder time", () => {
      expect(() => coalesce()).toThrow(/requires at least one argument/)
    })

    it("coalesce(x) with one arg still works", () => {
      const r = coalesce({ node: { type: "literal", value: 1 } } as any)
      expect((r as any).node).toEqual({
        type: "function_call",
        name: "COALESCE",
        args: [{ type: "literal", value: 1 }],
      })
    })
  })

  describe("MSSQL OUTPUT drops table qualifier on star (pseudo-tables only)", () => {
    it("INSERT ... RETURNING star('orders') → OUTPUT INSERTED.*", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "orders" }),
        columns: ["name"],
        values: [[{ type: "literal", value: "x" }]],
        returning: [{ type: "star", table: "orders" }],
      }
      const r = new MssqlPrinter().print(node)
      expect(r.sql).toContain("OUTPUT INSERTED.*")
      expect(r.sql).not.toContain("INSERTED.[orders].*")
    })

    it("bare RETURNING * → OUTPUT INSERTED.*", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "orders" }),
        columns: ["name"],
        values: [[{ type: "literal", value: "x" }]],
        returning: [{ type: "star" }],
      }
      const r = new MssqlPrinter().print(node)
      expect(r.sql).toContain("OUTPUT INSERTED.*")
    })
  })

  describe("MySQL / SQLite JSON `->` uses JSONPath ($.path / $[n])", () => {
    it("MySQL at('name') → `data`->'$.name'", () => {
      const r = new MysqlPrinter().print(selectJsonAccess("->", "name"))
      expect(r.sql).toContain("->'$.name'")
      expect(r.sql).not.toMatch(/->'name'/)
    })

    it("MySQL at('0') → `data`->'$[0]' (array index)", () => {
      const r = new MysqlPrinter().print(selectJsonAccess("->", "0"))
      expect(r.sql).toContain("->'$[0]'")
      expect(r.sql).not.toContain("->'0'")
    })

    it("SQLite ->> name → \"data\"->>'$.name'", () => {
      const r = new SqlitePrinter().print(selectJsonAccess("->>", "name"))
      expect(r.sql).toContain("->>'$.name'")
    })

    it("embedded single quote in path key is escape-doubled", () => {
      // e.g. `at("a'b")` should still land as a well-formed literal.
      const r = new MysqlPrinter().print(selectJsonAccess("->", "a'b"))
      expect(r.sql).toContain("->'$.a''b'")
    })
  })
})
