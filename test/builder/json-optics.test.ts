import { describe, expect, it } from "vitest"

import type { AliasedExprNode, CastNode, JsonAccessNode } from "../../src/ast/nodes.ts"
import { jsonCol, jsonExpr, JsonOptic } from "../../src/builder/json-optics.ts"
import { PgPrinter } from "../../src/printer/pg.ts"

describe("JsonOptic", () => {
  describe("jsonCol", () => {
    it("creates an optic from a column name", () => {
      const optic = jsonCol("data")
      expect(optic._node.type).toBe("column_ref")
    })

    it("creates an optic with table prefix", () => {
      const optic = jsonCol("data", "users")
      expect(optic._node.type).toBe("column_ref")
      const node = optic._node as any
      expect(node.column).toBe("data")
      expect(node.table).toBe("users")
    })
  })

  describe(".at()", () => {
    it("creates a -> JSON access", () => {
      const optic = jsonCol("data").at("address")
      const node = optic._node as JsonAccessNode
      expect(node.type).toBe("json_access")
      expect(node.operator).toBe("->")
      expect(node.path).toBe("address")
    })

    it("chains multiple .at() calls", () => {
      const optic = jsonCol("data").at("address").at("city")
      const node = optic._node as JsonAccessNode
      expect(node.type).toBe("json_access")
      expect(node.operator).toBe("->")
      expect(node.path).toBe("city")
      // The inner expression should also be a json_access
      const inner = node.expr as JsonAccessNode
      expect(inner.type).toBe("json_access")
      expect(inner.path).toBe("address")
    })
  })

  describe(".text()", () => {
    it("creates a ->> JSON text access", () => {
      const expr = jsonCol("data").text("name")
      const node = expr._node as JsonAccessNode
      expect(node.type).toBe("json_access")
      expect(node.operator).toBe("->>")
      expect(node.path).toBe("name")
    })
  })

  describe(".atPath()", () => {
    it("creates a #> path access", () => {
      const optic = jsonCol("data").atPath("address.city")
      const node = optic._node as JsonAccessNode
      expect(node.type).toBe("json_access")
      expect(node.operator).toBe("#>")
      expect(node.path).toBe("address.city")
    })
  })

  describe(".textPath()", () => {
    it("creates a #>> text path access", () => {
      const expr = jsonCol("data").textPath("address.city")
      const node = expr._node as JsonAccessNode
      expect(node.type).toBe("json_access")
      expect(node.operator).toBe("#>>")
      expect(node.path).toBe("address.city")
    })
  })

  describe(".asText()", () => {
    it("converts -> to ->>", () => {
      const expr = jsonCol("data").at("name").asText()
      const node = expr._node as JsonAccessNode
      expect(node.type).toBe("json_access")
      expect(node.operator).toBe("->>")
      expect(node.path).toBe("name")
    })

    it("casts non-json-access to text", () => {
      const optic = new JsonOptic({ type: "column_ref", column: "data" })
      const expr = optic.asText()
      const node = expr._node as CastNode
      expect(node.type).toBe("cast")
      expect(node.dataType).toBe("text")
    })
  })

  describe(".as()", () => {
    it("aliases a JSON expression", () => {
      const expr = jsonCol("data").text("name").as("user_name")
      const node = expr as any
      expect(node.type).toBe("json_access")
      expect(node.alias).toBe("user_name")
    })

    it("aliases non-json node with aliased_expr", () => {
      const optic = new JsonOptic({ type: "column_ref", column: "data" })
      const expr = optic.asText().as("text_data")
      // asText on non-json-access creates a cast, then .as wraps it
      const node = expr as any
      expect(node.type).toBe("aliased_expr")
      expect(node.alias).toBe("text_data")
    })
  })

  describe("SQL generation", () => {
    it("generates correct PG JSON SQL", () => {
      const optic = jsonCol("data").at("address").at("city")
      const printer = new PgPrinter()
      const selectNode = {
        type: "select" as const,
        distinct: false,
        columns: [optic._node],
        from: { type: "table_ref" as const, name: "users" },
        joins: [],
        groupBy: [],
        orderBy: [],
        ctes: [],
      }
      const result = printer.print(selectNode)
      expect(result.sql).toContain("->")
    })

    it("generates ->> for text extraction", () => {
      const expr = jsonCol("data").text("name")
      const printer = new PgPrinter()
      const selectNode = {
        type: "select" as const,
        distinct: false,
        columns: [expr._node],
        from: { type: "table_ref" as const, name: "users" },
        joins: [],
        groupBy: [],
        orderBy: [],
        ctes: [],
      }
      const result = printer.print(selectNode)
      expect(result.sql).toContain("->>")
    })
  })
})
