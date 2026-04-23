import { describe, expect, it } from "vitest"

import type { ASTNode, ExpressionNode, LiteralNode, SelectNode } from "../../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../../src/ast/nodes.ts"
import { UnreachableNodeError, assertNever } from "../../src/errors.ts"
import { normalizeExpression } from "../../src/normalize/expression.ts"
import { normalizeQuery } from "../../src/normalize/query.ts"
import { PluginManager } from "../../src/plugin/plugin-manager.ts"

// Fabricate a valid-looking node with a bogus `type` that does not exist in
// the ExpressionNode / ASTNode unions. Every exhaustive switch must either
// route it through an explicit branch (compile-time) or throw
// UnreachableNodeError (runtime backstop) — never silently drop it.
const bogusExpr = {
  type: "bogus_expr_kind_that_does_not_exist",
  value: 1,
} as unknown as ExpressionNode
const bogusNode = { type: "bogus_node_kind_that_does_not_exist" } as unknown as ASTNode

describe("AST exhaustiveness", () => {
  describe("assertNever helper", () => {
    it("throws UnreachableNodeError with context + node kind", () => {
      expect(() => assertNever(bogusExpr as never, "test")).toThrow(UnreachableNodeError)
      try {
        assertNever(bogusExpr as never, "unit")
      } catch (err) {
        expect(err).toBeInstanceOf(UnreachableNodeError)
        expect((err as Error).message).toContain("unit")
        expect((err as Error).message).toContain("bogus_expr_kind_that_does_not_exist")
      }
    })
  })

  describe("runtime backstops (never-checks in exhaustive switches)", () => {
    it("PluginManager.walkChildSelects throws on unknown ASTNode kind", () => {
      const mgr = new PluginManager([{ name: "test", transformNode: (n) => n }])
      expect(() => mgr.transformNode(bogusNode)).toThrow(UnreachableNodeError)
    })

    it("PluginManager.walkExpression throws on unknown ExpressionNode kind (via WHERE)", () => {
      const mgr = new PluginManager([{ name: "test", transformNode: (n) => n }])
      const sel: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        where: bogusExpr,
      }
      expect(() => mgr.transformNode(sel)).toThrow(UnreachableNodeError)
    })

    it("normalize.recurse throws on unknown ExpressionNode kind", () => {
      // foldConstants applies recurse under the hood when descending into
      // a recognized parent (e.g. binary_op with a bogus child).
      const literal: LiteralNode = { type: "literal", value: 1 }
      const parent: ExpressionNode = {
        type: "binary_op",
        op: "+",
        left: literal,
        right: bogusExpr,
      }
      expect(() => normalizeExpression(parent)).toThrow(UnreachableNodeError)
    })

    it("normalizeQuery throws on unknown top-level kind", () => {
      expect(() => normalizeQuery(bogusNode)).toThrow(UnreachableNodeError)
    })
  })
})
