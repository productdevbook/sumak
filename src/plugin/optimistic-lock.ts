import { and, binOp, col, eq, param } from "../ast/expression.ts"
import type { ASTNode, InsertNode, UpdateNode } from "../ast/nodes.ts"
import { QueryFlags } from "../ast/nodes.ts"
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
  private initialVersion: number

  constructor(config: {
    tables: string[]
    column?: string
    currentVersion?: number | (() => number)
    /** Version seeded on every INSERT. Defaults to 1. */
    initialVersion?: number
  }) {
    this.tables = new Set(config.tables)
    this.column = config.column ?? "version"
    const curr = config.currentVersion ?? 1
    this.getVersion = typeof curr === "function" ? curr : () => curr as number
    this.initialVersion = config.initialVersion ?? 1
  }

  transformNode(node: ASTNode): ASTNode {
    if (node.type === "update") return this.transformUpdate(node)
    if (node.type === "insert") return this.transformInsert(node)
    return node
  }

  /**
   * Append `version = :initial` to every inserted row so the column is
   * never NULL. Without this, `WHERE version = :current` on the next
   * UPDATE never matches (NULL ≠ anything), locking the row out of all
   * updates. Idempotent via `OptimisticLockApplied` on the InsertNode
   * flags.
   */
  private transformInsert(node: InsertNode): InsertNode {
    if (!this.tables.has(node.table.name)) return node
    const flags = node.flags ?? 0
    if (flags & QueryFlags.OptimisticLockApplied) return node
    // If the caller already provides the version column, don't
    // duplicate it.
    if (node.columns.includes(this.column)) return node
    // INSERT ... DEFAULT VALUES can't be extended — the shape has no
    // slot for an explicit column/value. Leave it; caller gets whatever
    // DDL DEFAULT the schema defines.
    if (node.defaultValues) return node
    const initial = this.initialVersion
    const columns = [...node.columns, this.column]
    const values = node.values.map((row) => [...row, { type: "literal" as const, value: initial }])
    return { ...node, columns, values, flags: flags | QueryFlags.OptimisticLockApplied }
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.tables.has(node.table.name)) return node
    const flags = node.flags ?? 0
    // Idempotent — double registration or re-compile would otherwise
    // emit `SET version = version + 1, version = version + 1` (duplicate
    // column — PG rejects it, other dialects pick a value nondeterministic).
    if (flags & QueryFlags.OptimisticLockApplied) return node

    const versionCondition = eq(col(this.column), param(0, this.getVersion()))
    const where = node.where ? and(node.where, versionCondition) : versionCondition

    const versionIncrement = binOp("+", col(this.column), { type: "literal", value: 1 })
    const set = [...node.set, { column: this.column, value: versionIncrement }]

    return { ...node, set, where, flags: flags | QueryFlags.OptimisticLockApplied }
  }
}
