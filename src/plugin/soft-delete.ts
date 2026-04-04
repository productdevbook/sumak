import { and, col, fn, isNull } from "../ast/expression.ts"
import type { ASTNode, DeleteNode, ExpressionNode, SelectNode, UpdateNode } from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * Plugin that automatically handles soft deletes for configured tables.
 *
 * In "convert" mode (default):
 * - SELECT/UPDATE: adds `WHERE deleted_at IS NULL`
 * - DELETE: converts to `UPDATE SET deleted_at = NOW() WHERE ... AND deleted_at IS NULL`
 *
 * In "filter" mode:
 * - SELECT/UPDATE/DELETE: adds `WHERE deleted_at IS NULL`
 *
 * ```ts
 * const plugin = new SoftDeletePlugin({ tables: ["users", "posts"] })
 * // DELETE FROM "users" WHERE id = 1
 * // → UPDATE "users" SET "deleted_at" = NOW() WHERE id = 1 AND "deleted_at" IS NULL
 * ```
 */
export class SoftDeletePlugin implements SumakPlugin {
  readonly name = "soft-delete"
  private tables: ReadonlySet<string>
  private column: string
  private mode: "filter" | "convert"

  constructor(config: { tables: string[]; column?: string; mode?: "filter" | "convert" }) {
    this.tables = new Set(config.tables)
    this.column = config.column ?? "deleted_at"
    this.mode = config.mode ?? "convert"
  }

  transformNode(node: ASTNode): ASTNode {
    switch (node.type) {
      case "select":
        return this.transformSelect(node)
      case "update":
        return this.transformUpdate(node)
      case "delete":
        return this.transformDelete(node)
      default:
        return node
    }
  }

  private isTargetTable(tableName: string): boolean {
    return this.tables.has(tableName)
  }

  private softDeleteCondition(): ExpressionNode {
    return isNull(col(this.column))
  }

  private addCondition(existing: ExpressionNode | undefined): ExpressionNode {
    const condition = this.softDeleteCondition()
    return existing ? and(existing, condition) : condition
  }

  private transformSelect(node: SelectNode): SelectNode {
    if (!node.from || node.from.type !== "table_ref" || !this.isTargetTable(node.from.name)) {
      return node
    }
    return { ...node, where: this.addCondition(node.where) }
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.isTargetTable(node.table.name)) return node
    return { ...node, where: this.addCondition(node.where) }
  }

  private transformDelete(node: DeleteNode): ASTNode {
    if (!this.isTargetTable(node.table.name)) return node

    if (this.mode === "filter") {
      return { ...node, where: this.addCondition(node.where) }
    }

    const updateNode: UpdateNode = {
      type: "update",
      table: node.table,
      set: [{ column: this.column, value: fn("NOW", []) }],
      where: this.addCondition(node.where),
      returning: node.returning,
      joins: node.joins,
      ctes: node.ctes,
    }

    return updateNode
  }
}
