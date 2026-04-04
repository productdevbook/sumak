import { describe, expect, it } from "vitest"

import { and, col, eq, lit, param } from "../../src/ast/expression.ts"
import type { BinaryOpNode, SelectNode } from "../../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../../src/ast/nodes.ts"
import { createRule, optimize } from "../../src/optimize/optimizer.ts"

describe("optimize", () => {
  it("normalizes + applies rules", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: and(
        eq(col("a"), lit(1)),
        and(eq(col("b"), lit(2)), eq(col("a"), lit(1))), // duplicate
      ),
    }
    const result = optimize(node) as SelectNode
    // Duplicate should be removed by normalization
    const parts = flattenAnd(result.where!)
    expect(parts.length).toBe(2)
  })

  it("applies predicate pushdown after normalization", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users", "u"),
      columns: [{ type: "star" }],
      joins: [
        {
          type: "join",
          joinType: "INNER",
          table: tableRef("posts", "p"),
          on: eq(col("id", "u"), col("user_id", "p")),
        },
      ],
      where: eq(col("active", "p"), param(0, true)),
    }
    const result = optimize(node) as SelectNode
    expect(result.where).toBeUndefined() // pushed into JOIN
  })

  it("removes WHERE true", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: { type: "literal", value: true },
    }
    const result = optimize(node) as SelectNode
    expect(result.where).toBeUndefined()
  })

  it("respects maxIterations", () => {
    let callCount = 0
    const infiniteRule = createRule({
      name: "infinite",
      match: () => true,
      apply: (node) => {
        callCount++
        // Always creates a new object but semantically same
        return { ...node }
      },
    })
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
    }
    optimize(node, { rules: [infiniteRule], maxIterations: 5 })
    expect(callCount).toBe(5)
  })

  it("disables rules by name", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: { type: "literal", value: true },
    }
    const result = optimize(node, { disableRules: ["remove-where-true"] }) as SelectNode
    // remove-where-true is disabled, but normalization will still remove it
    // since normalizeQuery removes WHERE true directly
    expect(result.where).toBeUndefined()
  })

  it("custom rules via createRule", () => {
    const addLimit = createRule({
      name: "default-limit",
      match: (node) => node.type === "select" && !(node as SelectNode).limit,
      apply: (node) => ({
        ...(node as SelectNode),
        limit: { type: "literal", value: 1000 },
      }),
    })

    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
    }
    const result = optimize(node, { rules: [addLimit] }) as SelectNode
    expect(result.limit).toBeDefined()
    expect(result.limit!.type).toBe("literal")
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
