import { binOp, col, fn, isNull, lit } from "../ast/expression.ts"
import type { ASTNode, ExpressionNode, UpdateNode } from "../ast/nodes.ts"
import { QueryFlags } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { SoftDeleteFlag } from "../plugin/soft-delete.ts"
import type { Printer } from "../printer/types.ts"
import type { CompiledQuery } from "../types.ts"
import type { WhereCallback } from "./eb.ts"
import { createColumnProxies } from "./eb.ts"

/**
 * Resolved runtime config read from a registered SoftDeletePlugin — used
 * by `db.softDelete()` / `db.restore()` to build race-safe UPDATE nodes.
 */
export interface SoftDeleteConfig {
  column: string
  flag: SoftDeleteFlag
}

function deletedValue(cfg: SoftDeleteConfig): ExpressionNode {
  // CURRENT_TIMESTAMP is SQL:92 and printed as a bare keyword — portable
  // across pg, mysql, sqlite, and mssql. See printer/base.ts NILADIC_FUNCTIONS.
  return cfg.flag === "timestamp" ? fn("CURRENT_TIMESTAMP", []) : lit(true)
}

function aliveValue(cfg: SoftDeleteConfig): ExpressionNode {
  return cfg.flag === "timestamp" ? lit(null) : lit(false)
}

function aliveCondition(cfg: SoftDeleteConfig): ExpressionNode {
  if (cfg.flag === "timestamp") return isNull(col(cfg.column))
  return binOp("=", col(cfg.column), lit(false))
}

function deletedCondition(cfg: SoftDeleteConfig): ExpressionNode {
  if (cfg.flag === "timestamp") return isNull(col(cfg.column), true)
  return binOp("=", col(cfg.column), lit(true))
}

function andNodes(a: ExpressionNode | undefined, b: ExpressionNode): ExpressionNode {
  return a ? { type: "binary_op", op: "AND", left: a, right: b } : b
}

/**
 * Base implementation for soft-delete-style write builders that always
 * AND a fixed "race-safe" predicate onto whatever the user provides.
 *
 * Separates `_userWhere` (accumulated user predicates, AND-chained across
 * multiple `.where()` calls) from the race-safe predicate (added at build
 * time so it's always the *last* clause in the SQL, regardless of how
 * many times the user called `.where()`).
 */
abstract class SoftDeleteLikeBuilder<DB, TB extends keyof DB, Self> {
  protected readonly _table: TB & string
  protected readonly _cfg: SoftDeleteConfig
  protected readonly _userWhere: ExpressionNode | undefined
  protected readonly _returning: ExpressionNode[]
  protected readonly _compile?: (node: ASTNode) => CompiledQuery
  protected readonly _printer?: Printer

  constructor(opts: {
    table: TB & string
    cfg: SoftDeleteConfig
    userWhere?: ExpressionNode
    returning?: ExpressionNode[]
    compile?: (n: ASTNode) => CompiledQuery
    printer?: Printer
  }) {
    this._table = opts.table
    this._cfg = opts.cfg
    this._userWhere = opts.userWhere
    this._returning = opts.returning ?? []
    this._compile = opts.compile
    this._printer = opts.printer
  }

  protected abstract _clone(
    next: Partial<{ userWhere: ExpressionNode; returning: ExpressionNode[] }>,
  ): Self

  /** Race-safe predicate appended as the *last* WHERE term. */
  protected abstract _racePredicate(): ExpressionNode

  /** SET clause. */
  protected abstract _setClause(): { column: string; value: ExpressionNode }[]

  /** Soft-delete mode to put on the node (for the plugin). */
  protected abstract _softDeleteMode(): "include" | undefined

  where(exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>): Self {
    const raw =
      typeof exprOrCallback === "function"
        ? unwrap(exprOrCallback(createColumnProxies<DB, TB>(this._table)))
        : unwrap(exprOrCallback)
    // AND-chain onto accumulated user predicates — prior .where() calls
    // are preserved. The race-safe predicate is added at build() time.
    return this._clone({ userWhere: andNodes(this._userWhere, raw) })
  }

  returning<K extends keyof DB[TB] & string>(...cols: K[]): Self {
    const returning: ExpressionNode[] = cols.map((c) => ({ type: "column_ref", column: c }))
    return this._clone({ returning })
  }

  returningAll(): Self {
    return this._clone({ returning: [{ type: "star" }] })
  }

  build(): UpdateNode {
    const race = this._racePredicate()
    const where = this._userWhere ? andNodes(this._userWhere, race) : race
    const node: UpdateNode = {
      type: "update",
      table: { type: "table_ref", name: this._table },
      set: this._setClause(),
      where,
      returning: this._returning,
      joins: [],
      ctes: [],
      // Mark as already filtered so the plugin doesn't re-apply.
      flags: QueryFlags.SoftDeleteApplied,
    }
    const mode = this._softDeleteMode()
    if (mode) node.softDeleteMode = mode
    return node
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this.build())
    if (!this._printer) {
      throw new Error("toSQL() requires a printer — build with db.softDelete(...) not directly.")
    }
    return this._printer.print(this.build())
  }
}

/**
 * Builder for explicit soft-delete —
 *   `UPDATE table SET <col> = CURRENT_TIMESTAMP WHERE <user predicate> AND <col> IS NULL`.
 * The trailing `AND <col> IS NULL` is race-safe: concurrent restore+delete
 * cannot double-toggle.
 *
 * ```ts
 * db.softDelete("users").where(({ id }) => id.eq(1)).toSQL()
 * // UPDATE "users" SET "deleted_at" = CURRENT_TIMESTAMP
 * //   WHERE ("id" = $1) AND "deleted_at" IS NULL
 * ```
 */
export class SoftDeleteBuilder<DB, TB extends keyof DB> extends SoftDeleteLikeBuilder<
  DB,
  TB,
  SoftDeleteBuilder<DB, TB>
> {
  protected _clone(
    next: Partial<{ userWhere: ExpressionNode; returning: ExpressionNode[] }>,
  ): SoftDeleteBuilder<DB, TB> {
    return new SoftDeleteBuilder<DB, TB>({
      table: this._table,
      cfg: this._cfg,
      userWhere: next.userWhere ?? this._userWhere,
      returning: next.returning ?? this._returning,
      compile: this._compile,
      printer: this._printer,
    })
  }
  protected _racePredicate(): ExpressionNode {
    return aliveCondition(this._cfg)
  }
  protected _setClause() {
    return [{ column: this._cfg.column, value: deletedValue(this._cfg) }]
  }
  protected _softDeleteMode(): "include" | undefined {
    return undefined
  }
}

/**
 * Builder for explicit restore — undoes a soft delete with a race-safe
 * predicate that only touches rows that are currently marked deleted.
 *
 * ```ts
 * db.restore("users").where(({ id }) => id.eq(1)).toSQL()
 * // UPDATE "users" SET "deleted_at" = NULL
 * //   WHERE ("id" = $1) AND "deleted_at" IS NOT NULL
 * ```
 */
export class RestoreBuilder<DB, TB extends keyof DB> extends SoftDeleteLikeBuilder<
  DB,
  TB,
  RestoreBuilder<DB, TB>
> {
  protected _clone(
    next: Partial<{ userWhere: ExpressionNode; returning: ExpressionNode[] }>,
  ): RestoreBuilder<DB, TB> {
    return new RestoreBuilder<DB, TB>({
      table: this._table,
      cfg: this._cfg,
      userWhere: next.userWhere ?? this._userWhere,
      returning: next.returning ?? this._returning,
      compile: this._compile,
      printer: this._printer,
    })
  }
  protected _racePredicate(): ExpressionNode {
    return deletedCondition(this._cfg)
  }
  protected _setClause() {
    return [{ column: this._cfg.column, value: aliveValue(this._cfg) }]
  }
  protected _softDeleteMode(): "include" | undefined {
    // Restore targets deleted rows; bypass any automatic "alive" filter.
    return "include"
  }
}
