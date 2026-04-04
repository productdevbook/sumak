import { and, binOp, col, eq, param } from "../ast/expression.ts"
import type { ASTNode, UpdateNode } from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * Plugin that implements optimistic locking for configured tables.
 *
 * On UPDATE for configured tables:
 * 1. Adds `WHERE version = :currentVersion` (ANDed with existing WHERE)
 * 2. Adds `SET version = version + 1` to the SET clause
 *
 * ```ts
 * const plugin = new OptimisticLockPlugin({
 *   tables: ["users", "posts"],
 *   currentVersion: 3,
 * })
 * // UPDATE "users" SET "name" = $1 WHERE id = $2
 * // → UPDATE "users" SET "name" = $1, "version" = "version" + 1 WHERE id = $2 AND "version" = $3
 * ```
 */
export class OptimisticLockPlugin implements SumakPlugin {
  readonly name = "optimistic-lock"
  private tables: ReadonlySet<string>
  private column: string
  private currentVersion: number

  constructor(config: { tables: string[]; column?: string; currentVersion: number }) {
    this.tables = new Set(config.tables)
    this.column = config.column ?? "version"
    this.currentVersion = config.currentVersion
  }

  transformNode(node: ASTNode): ASTNode {
    if (node.type !== "update") return node
    return this.transformUpdate(node)
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.tables.has(node.table.name)) return node

    const versionCondition = eq(col(this.column), param(0, this.currentVersion))
    const where = node.where ? and(node.where, versionCondition) : versionCondition

    const versionIncrement = binOp("+", col(this.column), { type: "literal", value: 1 })
    const set = [...node.set, { column: this.column, value: versionIncrement }]

    return { ...node, set, where }
  }
}
