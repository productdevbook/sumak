import {
  col as rawCol,
  lit as rawLit,
  param as rawParam,
  and as rawAnd,
  or as rawOr,
  fn as rawFn,
  star as rawStar,
  exists as rawExists,
  cast as rawCast,
  not as rawNot,
} from "../ast/expression.ts"
import type {
  CaseNode,
  ExpressionNode,
  FullTextSearchMode,
  FullTextSearchNode,
  JsonAccessNode,
  SelectNode,
} from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import type { SelectType } from "../schema/types.ts"

/**
 * A typed column reference that exposes comparison methods.
 *
 * ```ts
 * // users.id.eq(42) → ("id" = $1) with param [42]
 * // users.name.like("%ali%") → ("name" LIKE '%ali%')
 * ```
 */
export class Col<T> {
  /** @internal */
  readonly _node: ExpressionNode
  declare readonly _type: T

  constructor(column: string, table?: string) {
    this._node = rawCol(column, table)
  }

  /** = */
  eq(value: T): Expression<boolean> {
    return wrap(binOp("=", this._node, autoParam(value)))
  }

  /** != */
  neq(value: T): Expression<boolean> {
    return wrap(binOp("!=", this._node, autoParam(value)))
  }

  /** > */
  gt(value: T): Expression<boolean> {
    return wrap(binOp(">", this._node, autoParam(value)))
  }

  /** >= */
  gte(value: T): Expression<boolean> {
    return wrap(binOp(">=", this._node, autoParam(value)))
  }

  /** < */
  lt(value: T): Expression<boolean> {
    return wrap(binOp("<", this._node, autoParam(value)))
  }

  /** <= */
  lte(value: T): Expression<boolean> {
    return wrap(binOp("<=", this._node, autoParam(value)))
  }

  /** LIKE (string columns only) */
  like(this: Col<string>, pattern: string): Expression<boolean> {
    return wrap(binOp("LIKE", this._node, rawLit(pattern)))
  }

  /** IN (value1, value2, ...) */
  in(values: T[]): Expression<boolean> {
    return wrap({
      type: "in",
      expr: this._node,
      values: values.map((v) => autoParam(v)),
      negated: false,
    })
  }

  /** NOT IN */
  notIn(values: T[]): Expression<boolean> {
    return wrap({
      type: "in",
      expr: this._node,
      values: values.map((v) => autoParam(v)),
      negated: true,
    })
  }

  /** IS NULL */
  isNull(): Expression<boolean> {
    return wrap({ type: "is_null", expr: this._node, negated: false })
  }

  /** IS NOT NULL */
  isNotNull(): Expression<boolean> {
    return wrap({ type: "is_null", expr: this._node, negated: true })
  }

  /** BETWEEN low AND high */
  between(low: T, high: T): Expression<boolean> {
    return wrap({
      type: "between",
      expr: this._node,
      low: autoParam(low),
      high: autoParam(high),
      negated: false,
    })
  }

  /** Compare with another column: col1.eqCol(col2) */
  eqCol(other: Col<T>): Expression<boolean> {
    return wrap(binOp("=", this._node, other._node))
  }

  /** As raw Expression<T> for advanced use */
  toExpr(): Expression<T> {
    return wrap<T>(this._node)
  }
}

// ── Internal helpers ──

let _paramIdx = 0

export function resetParams(): void {
  _paramIdx = 0
}

function autoParam(value: unknown): ExpressionNode {
  return rawParam(_paramIdx++, value)
}

function binOp(op: string, left: ExpressionNode, right: ExpressionNode): ExpressionNode {
  return { type: "binary_op", op, left, right }
}

function wrap<T>(node: ExpressionNode): Expression<T> {
  return { node } as Expression<T>
}

/**
 * Create typed column proxies for a table's columns.
 *
 * Type: { id: Col<number>, name: Col<string>, ... }
 */
export type ColumnProxies<DB, TB extends keyof DB> = {
  [K in keyof DB[TB] & string]: Col<SelectType<DB[TB][K]>>
}

/**
 * Create column proxy objects for use in where/on callbacks.
 */
export function createColumnProxies<DB, TB extends keyof DB>(
  _table: TB & string,
): ColumnProxies<DB, TB> {
  return new Proxy({} as ColumnProxies<DB, TB>, {
    get(_target, prop: string) {
      return new Col(prop, undefined)
    },
  })
}

/**
 * Expression builder callback type.
 *
 * ```ts
 * .where(({ id, name }) => id.eq(42))
 * ```
 */
export type WhereCallback<DB, TB extends keyof DB> = (
  cols: ColumnProxies<DB, TB>,
) => Expression<boolean>

// ── Combinators for callback results ──

/** AND two expressions */
export function and(left: Expression<boolean>, right: Expression<boolean>): Expression<boolean> {
  return wrap(rawAnd((left as any).node, (right as any).node))
}

/** OR two expressions */
export function or(left: Expression<boolean>, right: Expression<boolean>): Expression<boolean> {
  return wrap(rawOr((left as any).node, (right as any).node))
}

/** Raw literal value as expression */
export function val<T extends string | number | boolean | null>(value: T): Expression<T> {
  return wrap<T>(rawLit(value))
}

/** SQL function call */
export function sqlFn(name: string, ...args: Expression<any>[]): Expression<any> {
  return wrap(
    rawFn(
      name,
      args.map((a) => (a as any).node),
    ),
  )
}

/** COUNT(*) */
export function count(): Expression<number> {
  return wrap(rawFn("COUNT", [rawStar()]))
}

/** SUM(expr) */
export function sum(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("SUM", [(expr as any).node]))
}

/** AVG(expr) */
export function avg(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("AVG", [(expr as any).node]))
}

/** MIN(expr) */
export function min<T>(expr: Expression<T>): Expression<T> {
  return wrap(rawFn("MIN", [(expr as any).node]))
}

/** MAX(expr) */
export function max<T>(expr: Expression<T>): Expression<T> {
  return wrap(rawFn("MAX", [(expr as any).node]))
}

/** COALESCE(expr, fallback) */
export function coalesce<T>(expr: Expression<T | null>, fallback: Expression<T>): Expression<T> {
  return wrap(rawFn("COALESCE", [(expr as any).node, (fallback as any).node]))
}

/** NOT expr */
export function not(expr: Expression<boolean>): Expression<boolean> {
  return wrap(rawNot((expr as any).node))
}

/** EXISTS (subquery) */
export function exists(query: SelectNode): Expression<boolean> {
  return wrap(rawExists(query))
}

/** NOT EXISTS (subquery) */
export function notExists(query: SelectNode): Expression<boolean> {
  return wrap(rawExists(query, true))
}

/** CAST(expr AS type) */
export function cast<T>(expr: Expression<any>, dataType: string): Expression<T> {
  return wrap<T>(rawCast((expr as any).node, dataType))
}

/**
 * JSON access operator: expr->path, expr->>path, etc.
 *
 * ```ts
 * jsonRef(cols.data, "name", "->>")  // data->>'name'
 * ```
 */
export function jsonRef<T = unknown>(
  expr: Expression<any>,
  path: string,
  operator: "->" | "->>" | "#>" | "#>>" = "->",
): Expression<T> {
  const node: JsonAccessNode = {
    type: "json_access",
    expr: (expr as any).node,
    path,
    operator,
  }
  return wrap<T>(node)
}

/**
 * Full-text search expression.
 *
 * Dialect-aware: PG uses tsvector/tsquery, MySQL uses MATCH/AGAINST,
 * SQLite uses FTS5 MATCH, MSSQL uses CONTAINS/FREETEXT.
 *
 * ```ts
 * // PostgreSQL: to_tsvector("name") @@ to_tsquery($1)
 * .where(() => textSearch([cols.name], val("alice")))
 *
 * // MySQL: MATCH(`name`) AGAINST(? IN BOOLEAN MODE)
 * .where(() => textSearch([cols.name], val("alice"), { mode: "boolean" }))
 * ```
 */
export function textSearch(
  columns: Expression<any>[],
  query: Expression<any>,
  options?: { mode?: FullTextSearchMode; language?: string },
): Expression<boolean> {
  const node: FullTextSearchNode = {
    type: "full_text_search",
    columns: columns.map((c) => (c as any).node),
    query: (query as any).node,
    mode: options?.mode,
    language: options?.language,
  }
  return wrap<boolean>(node)
}

/**
 * CASE expression builder.
 *
 * ```ts
 * case_()
 *   .when(cols.status.eq("active"), val(1))
 *   .when(cols.status.eq("inactive"), val(0))
 *   .else_(val(-1))
 *   .end()
 * ```
 */
export function case_(operand?: Expression<any>): CaseBuilder<never> {
  return new CaseBuilder(operand ? (operand as any).node : undefined, [])
}

export class CaseBuilder<T> {
  /** @internal */
  private _operand: ExpressionNode | undefined
  /** @internal */
  private _whens: { condition: ExpressionNode; result: ExpressionNode }[]
  /** @internal */
  private _else: ExpressionNode | undefined

  /** @internal */
  constructor(
    operand: ExpressionNode | undefined,
    whens: { condition: ExpressionNode; result: ExpressionNode }[],
    else_?: ExpressionNode,
  ) {
    this._operand = operand
    this._whens = whens
    this._else = else_
  }

  when<R>(condition: Expression<boolean>, result: Expression<R>): CaseBuilder<T | R> {
    return new CaseBuilder<T | R>(this._operand, [
      ...this._whens,
      { condition: (condition as any).node, result: (result as any).node },
    ])
  }

  else_<R>(result: Expression<R>): CaseBuilder<T | R> {
    return new CaseBuilder<T | R>(this._operand, this._whens, (result as any).node)
  }

  end(): Expression<T> {
    const node: CaseNode = {
      type: "case",
      operand: this._operand,
      whens: this._whens,
      else_: this._else,
    }
    return wrap<T>(node)
  }
}
