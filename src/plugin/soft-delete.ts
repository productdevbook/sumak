import { and, binOp, col, isNull, lit } from "../ast/expression.ts"
import type { ASTNode, ExpressionNode, SelectNode, UpdateNode } from "../ast/nodes.ts"
import { QueryFlags } from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * How the soft-delete column records its state.
 *
 * - `"timestamp"` (default) — column is a nullable timestamp; `NULL` means
 *   alive, any value means deleted. Filter is `WHERE deleted_at IS NULL`.
 * - `"boolean"` — column is a boolean; `FALSE` means alive, `TRUE` means
 *   deleted. Filter is `WHERE deleted = FALSE`. Hibernate 6.4-style; faster
 *   to index on some databases.
 */
export type SoftDeleteFlag = "timestamp" | "boolean"

export interface SoftDeletePluginConfig {
  tables: string[]
  /** Column name. Default: `deleted_at` (timestamp) or `deleted` (boolean). */
  column?: string
  /** Storage mode. Default: `"timestamp"`. */
  flag?: SoftDeleteFlag
}

/**
 * Automatically filters out soft-deleted rows on SELECT/UPDATE for the
 * configured tables by adding `WHERE <column> IS NULL` (timestamp flag)
 * or `WHERE <column> = FALSE` (boolean flag).
 *
 * DELETE is left alone — use `db.softDelete(table)` / `db.restore(table)`
 * for explicit soft-delete writes. If you call `db.deleteFrom(table)` on
 * a soft-delete table, you will get a hard DELETE.
 *
 * Bypass the filter with `.includeDeleted()` on the builder, or view only
 * deleted rows with `.onlyDeleted()`.
 *
 * ```ts
 * sumak({
 *   plugins: [softDelete({ tables: ["users"] })],
 *   ...
 * })
 *
 * db.selectFrom("users").toSQL()
 * // SELECT * FROM "users" WHERE "deleted_at" IS NULL
 *
 * db.selectFrom("users").includeDeleted().toSQL()
 * // SELECT * FROM "users"
 *
 * db.softDelete("users").where(({ id }) => id.eq(1)).toSQL()
 * // UPDATE "users" SET "deleted_at" = CURRENT_TIMESTAMP WHERE ("id" = $1) AND "deleted_at" IS NULL
 *
 * db.restore("users").where(({ id }) => id.eq(1)).toSQL()
 * // UPDATE "users" SET "deleted_at" = NULL WHERE ("id" = $1) AND "deleted_at" IS NOT NULL
 * ```
 */
export class SoftDeletePlugin implements SumakPlugin {
  readonly name = "soft-delete"
  private readonly _tables: ReadonlySet<string>
  private readonly _column: string
  private readonly _flag: SoftDeleteFlag

  /** @internal — used by `db.softDelete()` / `db.restore()` to resolve config. */
  readonly _config: Readonly<{ tables: ReadonlySet<string>; column: string; flag: SoftDeleteFlag }>

  constructor(config: SoftDeletePluginConfig) {
    this._flag = config.flag ?? "timestamp"
    this._column = config.column ?? (this._flag === "timestamp" ? "deleted_at" : "deleted")
    this._tables = new Set(config.tables)
    this._config = Object.freeze({
      tables: this._tables,
      column: this._column,
      flag: this._flag,
    })
  }

  transformNode(node: ASTNode): ASTNode {
    switch (node.type) {
      case "select":
        return this._transformSelect(node)
      case "update":
        return this._transformUpdate(node)
      default:
        // DELETE intentionally unchanged — `deleteFrom` means hard delete.
        return node
    }
  }

  private _isTargetTable(tableName: string): boolean {
    return this._tables.has(tableName)
  }

  /**
   * The predicate that means "row is alive".
   *   timestamp: deleted_at IS NULL
   *   boolean:   deleted = FALSE
   */
  private _aliveCondition(): ExpressionNode {
    if (this._flag === "timestamp") return isNull(col(this._column))
    return binOp("=", col(this._column), lit(false))
  }

  /** Inverse — "row is deleted". */
  private _deletedCondition(): ExpressionNode {
    if (this._flag === "timestamp") return isNull(col(this._column), true)
    return binOp("=", col(this._column), lit(true))
  }

  private _addCondition(
    existing: ExpressionNode | undefined,
    cond: ExpressionNode,
  ): ExpressionNode {
    return existing ? and(existing, cond) : cond
  }

  private _transformSelect(node: SelectNode): SelectNode {
    const flags = node.flags ?? 0
    // Already filtered → idempotent skip.
    if (flags & QueryFlags.SoftDeleteApplied) return node
    // User opted out of the automatic filter.
    if (node.softDeleteMode === "include") return node

    const fromIsTarget =
      node.from && node.from.type === "table_ref" && this._isTargetTable(node.from.name)

    // Rewrite any JOINed soft-delete tables too — a hidden `users` join
    // would otherwise surface deleted rows through the join.
    const joins = this._filterJoins(node.joins)
    const changedJoins = joins !== node.joins

    if (!fromIsTarget && !changedJoins) return node

    const cond = node.softDeleteMode === "only" ? this._deletedCondition() : this._aliveCondition()

    return {
      ...node,
      where: fromIsTarget ? this._addCondition(node.where, cond) : node.where,
      joins,
      flags: flags | QueryFlags.SoftDeleteApplied,
    }
  }

  private _transformUpdate(node: UpdateNode): UpdateNode {
    const flags = node.flags ?? 0
    if (flags & QueryFlags.SoftDeleteApplied) return node
    if (node.softDeleteMode === "include") return node
    if (!this._isTargetTable(node.table.name)) return node
    const cond = node.softDeleteMode === "only" ? this._deletedCondition() : this._aliveCondition()
    return {
      ...node,
      where: this._addCondition(node.where, cond),
      flags: flags | QueryFlags.SoftDeleteApplied,
    }
  }

  /**
   * For each JOIN targeting a soft-delete table, append the alive condition
   * to the join's ON clause. Used by _transformSelect.
   */
  private _filterJoins(
    joins: import("../ast/nodes.ts").JoinNode[],
  ): import("../ast/nodes.ts").JoinNode[] {
    let changed = false
    const out = joins.map((j) => {
      const t = j.table
      const tableName = t.type === "table_ref" ? t.name : undefined
      if (!tableName || !this._isTargetTable(tableName)) return j
      changed = true
      const cond = this._aliveCondition()
      const on = j.on ? and(j.on, cond) : cond
      return { ...j, on }
    })
    return changed ? out : joins
  }
}
