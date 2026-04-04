import { and, col, gt, lt, param } from "../ast/expression.ts"
import type { ASTNode, LiteralNode, OrderByNode, SelectNode } from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

export interface CursorPaginationConfig {
  pageSize: number
  cursor?: { column: string; value: unknown; direction?: "ASC" | "DESC" }
}

/**
 * Plugin for cursor-based (keyset) pagination.
 *
 * Transforms SELECT queries by injecting a WHERE condition for the cursor,
 * an ORDER BY clause (if missing), and a LIMIT of `pageSize + 1`
 * (the extra row lets consumers detect whether a next page exists).
 *
 * ```ts
 * const plugin = new CursorPaginationPlugin({ pageSize: 20, cursor: { column: "id", value: 42 } })
 * // SELECT * FROM "users"
 * // → SELECT * FROM "users" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 21
 * ```
 */
export class CursorPaginationPlugin implements SumakPlugin {
  readonly name = "cursor-pagination"
  private config: CursorPaginationConfig

  constructor(config: CursorPaginationConfig) {
    this.config = config
  }

  transformNode(node: ASTNode): ASTNode {
    if (node.type !== "select") return node
    return this.transformSelect(node)
  }

  private transformSelect(node: SelectNode): SelectNode {
    const { pageSize, cursor } = this.config
    const limit: LiteralNode = { type: "literal", value: pageSize + 1 }

    let result: SelectNode = { ...node, limit }

    if (cursor) {
      const direction = cursor.direction ?? "ASC"
      const cursorCol = col(cursor.column)
      const cursorParam = param(0, cursor.value)
      const condition =
        direction === "ASC" ? gt(cursorCol, cursorParam) : lt(cursorCol, cursorParam)

      const where = result.where ? and(result.where, condition) : condition

      const orderBy: OrderByNode[] =
        result.orderBy.length > 0 ? result.orderBy : [{ expr: cursorCol, direction }]

      result = { ...result, where, orderBy }
    }

    return result
  }
}
