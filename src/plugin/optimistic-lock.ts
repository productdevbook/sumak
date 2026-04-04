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
 * `currentVersion` accepts a value OR a function that returns the value per-query.
 * Use a function when the version varies per row/request:
 *
 * ```ts
 * let rowVersion = 3
 * const plugin = new OptimisticLockPlugin({
 *   tables: ["users"],
 *   currentVersion: () => rowVersion,
 * })
 *
 * // Before each update, set rowVersion to the row's current version
 * rowVersion = fetchedRow.version
 * db.update("users").set({ name: "Bob" }).where(...).toSQL()
 * // UPDATE ... SET "version" = "version" + 1 WHERE ... AND "version" = $N
 * ```
 */
export class OptimisticLockPlugin implements SumakPlugin {
  readonly name = "optimistic-lock"
  private tables: ReadonlySet<string>
  private column: string
  private getVersion: () => number

  constructor(config: {
    tables: string[]
    column?: string
    currentVersion: number | (() => number)
  }) {
    this.tables = new Set(config.tables)
    this.column = config.column ?? "version"
    this.getVersion =
      typeof config.currentVersion === "function"
        ? config.currentVersion
        : () => config.currentVersion as number
  }

  transformNode(node: ASTNode): ASTNode {
    if (node.type !== "update") return node
    return this.transformUpdate(node)
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.tables.has(node.table.name)) return node

    const versionCondition = eq(col(this.column), param(0, this.getVersion()))
    const where = node.where ? and(node.where, versionCondition) : versionCondition

    const versionIncrement = binOp("+", col(this.column), { type: "literal", value: 1 })
    const set = [...node.set, { column: this.column, value: versionIncrement }]

    return { ...node, set, where }
  }
}
