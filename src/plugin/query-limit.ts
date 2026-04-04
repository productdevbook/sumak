import type { ASTNode, LiteralNode, SelectNode } from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * Plugin that auto-injects a LIMIT on SELECT queries that don't already have one.
 *
 * ```ts
 * const plugin = new QueryLimitPlugin({ maxRows: 500 })
 * // SELECT * FROM "users"
 * // → SELECT * FROM "users" LIMIT 500
 * ```
 */
export class QueryLimitPlugin implements SumakPlugin {
  readonly name = "query-limit"
  private maxRows: number

  constructor(config?: { maxRows?: number }) {
    this.maxRows = config?.maxRows ?? 1000
  }

  transformNode(node: ASTNode): ASTNode {
    if (node.type !== "select") return node
    return this.transformSelect(node)
  }

  private transformSelect(node: SelectNode): SelectNode {
    if (node.limit) return node
    const limit: LiteralNode = { type: "literal", value: this.maxRows }
    return { ...node, limit }
  }
}
