import { describe, expect, it, vi } from "vitest"

import { col } from "../../src/ast/expression.ts"
import {
  createSelectNode,
  createInsertNode,
  createUpdateNode,
  createDeleteNode,
} from "../../src/ast/nodes.ts"
import { visitNode } from "../../src/ast/visitor.ts"
import type { ASTVisitor } from "../../src/ast/visitor.ts"

function createMockVisitor(): ASTVisitor<string> {
  return {
    visitSelect: vi.fn(() => "select"),
    visitInsert: vi.fn(() => "insert"),
    visitUpdate: vi.fn(() => "update"),
    visitDelete: vi.fn(() => "delete"),
    visitExpression: vi.fn(() => "expression"),
    visitJoin: vi.fn(() => "join"),
    visitOrderBy: vi.fn(() => "orderBy"),
    visitCTE: vi.fn(() => "cte"),
  }
}

describe("visitNode", () => {
  it("dispatches select to visitSelect", () => {
    const visitor = createMockVisitor()
    const result = visitNode(createSelectNode(), visitor)
    expect(result).toBe("select")
    expect(visitor.visitSelect).toHaveBeenCalledOnce()
  })

  it("dispatches insert to visitInsert", () => {
    const visitor = createMockVisitor()
    const result = visitNode(createInsertNode({ name: "t" }), visitor)
    expect(result).toBe("insert")
    expect(visitor.visitInsert).toHaveBeenCalledOnce()
  })

  it("dispatches update to visitUpdate", () => {
    const visitor = createMockVisitor()
    const result = visitNode(createUpdateNode({ name: "t" }), visitor)
    expect(result).toBe("update")
    expect(visitor.visitUpdate).toHaveBeenCalledOnce()
  })

  it("dispatches delete to visitDelete", () => {
    const visitor = createMockVisitor()
    const result = visitNode(createDeleteNode({ name: "t" }), visitor)
    expect(result).toBe("delete")
    expect(visitor.visitDelete).toHaveBeenCalledOnce()
  })

  it("dispatches expression to visitExpression", () => {
    const visitor = createMockVisitor()
    const result = visitNode(col("id"), visitor)
    expect(result).toBe("expression")
    expect(visitor.visitExpression).toHaveBeenCalledOnce()
  })
})
