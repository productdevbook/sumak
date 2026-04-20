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
  return cfg.flag === "timestamp" ? fn("NOW", []) : lit(true)
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
 * Builder for explicit soft-delete — `UPDATE table SET <col> = NOW() WHERE ... AND <col> IS NULL`.
 * The trailing `AND <col> IS NULL` is race-safe: concurrent restore+delete cannot double-toggle.
 *
 * ```ts
 * db.softDelete("users").where(({ id }) => id.eq(1)).toSQL()
 * // UPDATE "users" SET "deleted_at" = NOW() WHERE ("id" = $1) AND "deleted_at" IS NULL
 * ```
 */
export class SoftDeleteBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _table: TB & string
  /** @internal */
  readonly _cfg: SoftDeleteConfig
  /** @internal */
  readonly _node: UpdateNode
  /** @internal */
  readonly _compile?: (node: ASTNode) => CompiledQuery
  /** @internal */
  readonly _printer?: Printer

  constructor(opts: {
    table: TB & string
    cfg: SoftDeleteConfig
    compile?: (n: ASTNode) => CompiledQuery
    printer?: Printer
    node?: UpdateNode
  }) {
    this._table = opts.table
    this._cfg = opts.cfg
    this._compile = opts.compile
    this._printer = opts.printer
    const base: UpdateNode = {
      type: "update",
      table: { type: "table_ref", name: opts.table },
      set: [{ column: opts.cfg.column, value: deletedValue(opts.cfg) }],
      where: aliveCondition(opts.cfg),
      returning: [],
      joins: [],
      ctes: [],
      // Mark the node as already filtered so the plugin doesn't ALSO
      // tack on another `deleted_at IS NULL`.
      flags: QueryFlags.SoftDeleteApplied,
    }
    this._node = opts.node ?? base
  }

  private _with(node: UpdateNode): SoftDeleteBuilder<DB, TB> {
    return new SoftDeleteBuilder<DB, TB>({
      table: this._table,
      cfg: this._cfg,
      compile: this._compile,
      printer: this._printer,
      node,
    })
  }

  where(exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>): SoftDeleteBuilder<DB, TB> {
    const raw =
      typeof exprOrCallback === "function"
        ? unwrap(exprOrCallback(createColumnProxies<DB, TB>(this._table)))
        : unwrap(exprOrCallback)
    // User-supplied predicate must come BEFORE the race-safe predicate so
    // the race-safe one is always last (and readable in generated SQL).
    // The node was created with where = aliveCondition; we rewrap.
    const racePredicate = aliveCondition(this._cfg)
    return this._with({ ...this._node, where: andNodes(raw, racePredicate) })
  }

  returning<K extends keyof DB[TB] & string>(...cols: K[]): SoftDeleteBuilder<DB, TB> {
    const returning: ExpressionNode[] = cols.map((c) => ({ type: "column_ref", column: c }))
    return this._with({ ...this._node, returning })
  }

  returningAll(): SoftDeleteBuilder<DB, TB> {
    return this._with({ ...this._node, returning: [{ type: "star" }] })
  }

  build(): UpdateNode {
    return this._node
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this._node)
  }

  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this._node)
    if (!this._printer) {
      throw new Error("toSQL() requires a printer — build with db.softDelete(...) not directly.")
    }
    return this._printer.print(this._node)
  }
}

/**
 * Builder for explicit restore — undoes a soft delete with a race-safe
 * predicate that only touches rows that are currently marked deleted.
 *
 * ```ts
 * db.restore("users").where(({ id }) => id.eq(1)).toSQL()
 * // UPDATE "users" SET "deleted_at" = NULL WHERE ("id" = $1) AND "deleted_at" IS NOT NULL
 * ```
 */
export class RestoreBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _table: TB & string
  /** @internal */
  readonly _cfg: SoftDeleteConfig
  /** @internal */
  readonly _node: UpdateNode
  /** @internal */
  readonly _compile?: (node: ASTNode) => CompiledQuery
  /** @internal */
  readonly _printer?: Printer

  constructor(opts: {
    table: TB & string
    cfg: SoftDeleteConfig
    compile?: (n: ASTNode) => CompiledQuery
    printer?: Printer
    node?: UpdateNode
  }) {
    this._table = opts.table
    this._cfg = opts.cfg
    this._compile = opts.compile
    this._printer = opts.printer
    const base: UpdateNode = {
      type: "update",
      table: { type: "table_ref", name: opts.table },
      set: [{ column: opts.cfg.column, value: aliveValue(opts.cfg) }],
      where: deletedCondition(opts.cfg),
      returning: [],
      joins: [],
      ctes: [],
      flags: QueryFlags.SoftDeleteApplied | QueryFlags.IncludeDeleted,
    }
    this._node = opts.node ?? base
  }

  private _with(node: UpdateNode): RestoreBuilder<DB, TB> {
    return new RestoreBuilder<DB, TB>({
      table: this._table,
      cfg: this._cfg,
      compile: this._compile,
      printer: this._printer,
      node,
    })
  }

  where(exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>): RestoreBuilder<DB, TB> {
    const raw =
      typeof exprOrCallback === "function"
        ? unwrap(exprOrCallback(createColumnProxies<DB, TB>(this._table)))
        : unwrap(exprOrCallback)
    const racePredicate = deletedCondition(this._cfg)
    return this._with({ ...this._node, where: andNodes(raw, racePredicate) })
  }

  returning<K extends keyof DB[TB] & string>(...cols: K[]): RestoreBuilder<DB, TB> {
    const returning: ExpressionNode[] = cols.map((c) => ({ type: "column_ref", column: c }))
    return this._with({ ...this._node, returning })
  }

  returningAll(): RestoreBuilder<DB, TB> {
    return this._with({ ...this._node, returning: [{ type: "star" }] })
  }

  build(): UpdateNode {
    return this._node
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this._node)
  }

  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this._node)
    if (!this._printer) {
      throw new Error("toSQL() requires a printer — build with db.restore(...) not directly.")
    }
    return this._printer.print(this._node)
  }
}
