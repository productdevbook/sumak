import { describe, expect, it } from "vitest"

import { and, col, eq, lit } from "../../src/ast/expression.ts"
import type { BinaryOpNode, SelectNode } from "../../src/ast/nodes.ts"
import {
  createDeleteNode,
  createSelectNode,
  createUpdateNode,
  tableRef,
} from "../../src/ast/nodes.ts"
import { normalizeQuery } from "../../src/normalize/query.ts"

describe("normalizeQuery", () => {
  describe("SELECT normalization", () => {
    it("normalizes WHERE clause", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        where: and(
          eq(col("a"), lit(1)),
          and(eq(col("b"), lit(2)), eq(col("a"), lit(1))), // duplicate
        ),
      }
      const result = normalizeQuery(node) as SelectNode
      expect(result.where).toBeDefined()
      // Duplicate should be removed
      const parts = flattenAnd(result.where!)
      expect(parts.length).toBe(2) // a=1, b=2
    })

    it("removes WHERE true", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        where: { type: "literal", value: true },
      }
      const result = normalizeQuery(node) as SelectNode
      expect(result.where).toBeUndefined()
    })

    it("normalizes HAVING clause", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        having: { type: "literal", value: true },
      }
      const result = normalizeQuery(node) as SelectNode
      expect(result.having).toBeUndefined()
    })

    it("normalizes JOIN ON conditions", () => {
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        joins: [
          {
            type: "join",
            joinType: "INNER",
            table: tableRef("posts"),
            on: and(eq(col("users.id"), col("posts.user_id")), { type: "literal", value: true }),
          },
        ],
      }
      const result = normalizeQuery(node) as SelectNode
      // AND true should be simplified
      const joinOn = result.joins[0].on!
      expect(joinOn.type).toBe("binary_op")
      expect((joinOn as BinaryOpNode).op).toBe("=")
    })

    it("normalizes CTE queries", () => {
      const innerSelect: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [{ type: "star" }],
        where: and(eq(col("a"), lit(1)), { type: "literal", value: true }),
      }
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("active_users"),
        columns: [{ type: "star" }],
        ctes: [{ name: "active_users", query: innerSelect, recursive: false }],
      }
      const result = normalizeQuery(node) as SelectNode
      const cteWhere = result.ctes[0].query.where
      // AND true should be simplified
      expect(cteWhere).toBeDefined()
      expect((cteWhere as BinaryOpNode).op).toBe("=")
    })
  })

  describe("UPDATE normalization", () => {
    it("normalizes WHERE clause", () => {
      const node = {
        ...createUpdateNode(tableRef("users")),
        set: [{ column: "name", value: lit("Bob") }],
        where: and(eq(col("id"), lit(1)), { type: "literal", value: true } as any),
      }
      const result = normalizeQuery(node)
      expect(result.type).toBe("update")
      if (result.type === "update") {
        expect(result.where).toBeDefined()
        expect((result.where as BinaryOpNode).op).toBe("=")
      }
    })
  })

  describe("DELETE normalization", () => {
    it("normalizes WHERE clause", () => {
      const node = {
        ...createDeleteNode(tableRef("users")),
        where: and(eq(col("id"), lit(1)), { type: "literal", value: true } as any),
      }
      const result = normalizeQuery(node)
      expect(result.type).toBe("delete")
      if (result.type === "delete") {
        expect(result.where).toBeDefined()
        expect((result.where as BinaryOpNode).op).toBe("=")
      }
    })
  })

  describe("INSERT normalization", () => {
    it("normalizes ON CONFLICT WHERE", () => {
      const node = {
        type: "insert" as const,
        table: tableRef("users"),
        columns: ["name"],
        values: [[lit("Alice")]],
        returning: [],
        ctes: [],
        onConflict: {
          columns: ["email"],
          action: "nothing" as const,
          where: and(eq(col("active"), lit(true)), {
            type: "literal",
            value: true,
          } as any),
        },
      }
      const result = normalizeQuery(node)
      if (result.type === "insert" && result.onConflict?.where) {
        expect((result.onConflict.where as BinaryOpNode).op).toBe("=")
      }
    })
  })

  describe("passthrough", () => {
    it("returns non-query nodes unchanged", () => {
      const node = {
        type: "explain" as const,
        statement: {
          ...createSelectNode(),
          from: tableRef("users"),
          columns: [{ type: "star" as const }],
        },
      }
      const result = normalizeQuery(node)
      expect(result).toBe(node)
    })
  })
})

function flattenAnd(
  expr: import("../../src/ast/nodes.ts").ExpressionNode,
): import("../../src/ast/nodes.ts").ExpressionNode[] {
  if (expr.type === "binary_op" && (expr as BinaryOpNode).op === "AND") {
    const b = expr as BinaryOpNode
    return [...flattenAnd(b.left), ...flattenAnd(b.right)]
  }
  return [expr]
}
