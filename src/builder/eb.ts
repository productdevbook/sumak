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
  FrameBound,
  FrameKind,
  FrameSpec,
  FullTextSearchMode,
  FullTextSearchNode,
  FunctionCallNode,
  JsonAccessNode,
  OrderByNode,
  SelectNode,
  TupleNode,
  WindowFunctionNode,
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

  /** NOT LIKE */
  notLike(this: Col<string>, pattern: string): Expression<boolean> {
    return wrap(binOp("NOT LIKE", this._node, rawLit(pattern)))
  }

  /** ILIKE — case-insensitive LIKE (PG) */
  ilike(this: Col<string>, pattern: string): Expression<boolean> {
    return wrap(binOp("ILIKE", this._node, rawLit(pattern)))
  }

  /** NOT ILIKE (PG) */
  notIlike(this: Col<string>, pattern: string): Expression<boolean> {
    return wrap(binOp("NOT ILIKE", this._node, rawLit(pattern)))
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

  /** NOT BETWEEN low AND high */
  notBetween(low: T, high: T): Expression<boolean> {
    return wrap({
      type: "between",
      expr: this._node,
      low: autoParam(low),
      high: autoParam(high),
      negated: true,
    })
  }

  /** BETWEEN SYMMETRIC low AND high (PG) — order-independent range check */
  betweenSymmetric(low: T, high: T): Expression<boolean> {
    return wrap({
      type: "between",
      expr: this._node,
      low: autoParam(low),
      high: autoParam(high),
      negated: false,
      symmetric: true,
    })
  }

  /** IN (SELECT ...) — subquery */
  inSubquery(query: SelectNode): Expression<boolean> {
    return wrap({
      type: "in",
      expr: this._node,
      values: query,
      negated: false,
    })
  }

  /** NOT IN (SELECT ...) — subquery */
  notInSubquery(query: SelectNode): Expression<boolean> {
    return wrap({
      type: "in",
      expr: this._node,
      values: query,
      negated: true,
    })
  }

  /** = with Expression value */
  eqExpr(value: Expression<T>): Expression<boolean> {
    return wrap(binOp("=", this._node, (value as any).node))
  }

  /** != with Expression value */
  neqExpr(value: Expression<T>): Expression<boolean> {
    return wrap(binOp("!=", this._node, (value as any).node))
  }

  /** > with Expression value */
  gtExpr(value: Expression<T>): Expression<boolean> {
    return wrap(binOp(">", this._node, (value as any).node))
  }

  /** < with Expression value */
  ltExpr(value: Expression<T>): Expression<boolean> {
    return wrap(binOp("<", this._node, (value as any).node))
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

/** COUNT(DISTINCT expr) */
export function countDistinct(expr: Expression<any>): Expression<number> {
  const node: FunctionCallNode = {
    type: "function_call",
    name: "COUNT",
    args: [(expr as any).node],
    distinct: true,
  }
  return wrap(node)
}

/** SUM(expr) */
export function sum(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("SUM", [(expr as any).node]))
}

/** SUM(DISTINCT expr) */
export function sumDistinct(expr: Expression<number>): Expression<number> {
  const node: FunctionCallNode = {
    type: "function_call",
    name: "SUM",
    args: [(expr as any).node],
    distinct: true,
  }
  return wrap(node)
}

/** AVG(expr) */
export function avg(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("AVG", [(expr as any).node]))
}

/** AVG(DISTINCT expr) */
export function avgDistinct(expr: Expression<number>): Expression<number> {
  const node: FunctionCallNode = {
    type: "function_call",
    name: "AVG",
    args: [(expr as any).node],
    distinct: true,
  }
  return wrap(node)
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

/** Unary minus: -expr */
export function neg(expr: Expression<number>): Expression<number> {
  return wrap({
    type: "unary_op",
    op: "-",
    operand: (expr as any).node,
    position: "prefix" as const,
  })
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

// ── Window Function Builder ──

/**
 * Window function builder.
 *
 * ```ts
 * over(count(), w => w.partitionBy("dept").orderBy("salary", "DESC"))
 * over(sqlFn("ROW_NUMBER"), w => w.partitionBy("dept").orderBy("id"))
 * ```
 */
export function over<T>(
  fn: Expression<T>,
  build: (w: WindowBuilder) => WindowBuilder,
): Expression<T> {
  const builder = build(new WindowBuilder())
  const fnNode = (fn as any).node as FunctionCallNode
  const node: WindowFunctionNode = {
    type: "window_function",
    fn: fnNode,
    partitionBy: builder._partitionBy,
    orderBy: builder._orderBy,
    frame: builder._frame,
  }
  return wrap<T>(node)
}

export class WindowBuilder {
  /** @internal */
  _partitionBy: ExpressionNode[] = []
  /** @internal */
  _orderBy: OrderByNode[] = []
  /** @internal */
  _frame: FrameSpec | undefined

  partitionBy(...columns: string[]): WindowBuilder {
    const b = new WindowBuilder()
    b._partitionBy = columns.map((c) => rawCol(c))
    b._orderBy = this._orderBy
    b._frame = this._frame
    return b
  }

  orderBy(column: string, direction: "ASC" | "DESC" = "ASC"): WindowBuilder {
    const b = new WindowBuilder()
    b._partitionBy = this._partitionBy
    b._orderBy = [...this._orderBy, { expr: rawCol(column), direction }]
    b._frame = this._frame
    return b
  }

  rows(start: FrameBound, end?: FrameBound): WindowBuilder {
    return this._withFrame("ROWS", start, end)
  }

  range(start: FrameBound, end?: FrameBound): WindowBuilder {
    return this._withFrame("RANGE", start, end)
  }

  groups(start: FrameBound, end?: FrameBound): WindowBuilder {
    return this._withFrame("GROUPS", start, end)
  }

  /** @internal */
  _withFrame(kind: FrameKind, start: FrameBound, end?: FrameBound): WindowBuilder {
    const b = new WindowBuilder()
    b._partitionBy = this._partitionBy
    b._orderBy = this._orderBy
    b._frame = { kind, start, end }
    return b
  }
}

// ── Convenience window functions ──

/** ROW_NUMBER() — must be used with over() */
export function rowNumber(): Expression<number> {
  return wrap(rawFn("ROW_NUMBER", []))
}

/** RANK() — must be used with over() */
export function rank(): Expression<number> {
  return wrap(rawFn("RANK", []))
}

/** DENSE_RANK() — must be used with over() */
export function denseRank(): Expression<number> {
  return wrap(rawFn("DENSE_RANK", []))
}

/** LAG(expr, offset?, default?) */
export function lag<T>(
  expr: Expression<T>,
  offset?: number,
  defaultValue?: Expression<T>,
): Expression<T> {
  const args: ExpressionNode[] = [(expr as any).node]
  if (offset !== undefined) args.push(rawLit(offset))
  if (defaultValue !== undefined) args.push((defaultValue as any).node)
  return wrap(rawFn("LAG", args))
}

/** LEAD(expr, offset?, default?) */
export function lead<T>(
  expr: Expression<T>,
  offset?: number,
  defaultValue?: Expression<T>,
): Expression<T> {
  const args: ExpressionNode[] = [(expr as any).node]
  if (offset !== undefined) args.push(rawLit(offset))
  if (defaultValue !== undefined) args.push((defaultValue as any).node)
  return wrap(rawFn("LEAD", args))
}

/** NTILE(n) */
export function ntile(n: number): Expression<number> {
  return wrap(rawFn("NTILE", [rawLit(n)]))
}

// ── Common SQL functions ──

/** UPPER(expr) */
export function upper(expr: Expression<string>): Expression<string> {
  return wrap(rawFn("UPPER", [(expr as any).node]))
}

/** LOWER(expr) */
export function lower(expr: Expression<string>): Expression<string> {
  return wrap(rawFn("LOWER", [(expr as any).node]))
}

/** CONCAT(a, b, ...) */
export function concat(...args: Expression<string>[]): Expression<string> {
  return wrap(
    rawFn(
      "CONCAT",
      args.map((a) => (a as any).node),
    ),
  )
}

/** SUBSTRING(expr, start, length?) */
export function substring(
  expr: Expression<string>,
  start: number,
  length?: number,
): Expression<string> {
  const args: ExpressionNode[] = [(expr as any).node, rawLit(start)]
  if (length !== undefined) args.push(rawLit(length))
  return wrap(rawFn("SUBSTRING", args))
}

/** TRIM(expr) */
export function trim(expr: Expression<string>): Expression<string> {
  return wrap(rawFn("TRIM", [(expr as any).node]))
}

/** LENGTH(expr) / CHAR_LENGTH(expr) */
export function length(expr: Expression<string>): Expression<number> {
  return wrap(rawFn("LENGTH", [(expr as any).node]))
}

/** NOW() */
export function now(): Expression<Date> {
  return wrap(rawFn("NOW", []))
}

/** CURRENT_TIMESTAMP */
export function currentTimestamp(): Expression<Date> {
  return wrap(rawFn("CURRENT_TIMESTAMP", []))
}

/** NULLIF(a, b) */
export function nullif<T>(a: Expression<T>, b: Expression<T>): Expression<T | null> {
  return wrap(rawFn("NULLIF", [(a as any).node, (b as any).node]))
}

/** GREATEST(a, b, ...) */
export function greatest<T>(...args: Expression<T>[]): Expression<T> {
  return wrap(
    rawFn(
      "GREATEST",
      args.map((a) => (a as any).node),
    ),
  )
}

/** LEAST(a, b, ...) */
export function least<T>(...args: Expression<T>[]): Expression<T> {
  return wrap(
    rawFn(
      "LEAST",
      args.map((a) => (a as any).node),
    ),
  )
}

/** ABS(expr) */
export function abs(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("ABS", [(expr as any).node]))
}

/** ROUND(expr, precision?) */
export function round(expr: Expression<number>, precision?: number): Expression<number> {
  const args: ExpressionNode[] = [(expr as any).node]
  if (precision !== undefined) args.push(rawLit(precision))
  return wrap(rawFn("ROUND", args))
}

/** CEIL(expr) */
export function ceil(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("CEIL", [(expr as any).node]))
}

/** FLOOR(expr) */
export function floor(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("FLOOR", [(expr as any).node]))
}

/** STRING_AGG(expr, delimiter) — aggregate strings with separator */
export function stringAgg(
  expr: Expression<string>,
  delimiter: string,
  orderBy?: { expr: Expression<any>; direction?: "ASC" | "DESC" }[],
): Expression<string> {
  const node: FunctionCallNode = {
    type: "function_call",
    name: "STRING_AGG",
    args: [(expr as any).node, rawLit(delimiter)],
    orderBy: orderBy?.map((o) => ({
      expr: (o.expr as any).node,
      direction: o.direction ?? "ASC",
    })),
  }
  return wrap(node)
}

/** ARRAY_AGG(expr) — aggregate values into array */
export function arrayAgg<T>(
  expr: Expression<T>,
  orderBy?: { expr: Expression<any>; direction?: "ASC" | "DESC" }[],
): Expression<T[]> {
  const node: FunctionCallNode = {
    type: "function_call",
    name: "ARRAY_AGG",
    args: [(expr as any).node],
    orderBy: orderBy?.map((o) => ({
      expr: (o.expr as any).node,
      direction: o.direction ?? "ASC",
    })),
  }
  return wrap(node)
}

/** Attach ORDER BY to an existing aggregate expression. */
export function aggOrderBy<T>(
  agg: Expression<T>,
  orderBy: { expr: Expression<any>; direction?: "ASC" | "DESC" }[],
): Expression<T> {
  const fnNode = (agg as any).node as FunctionCallNode
  return wrap<T>({
    ...fnNode,
    orderBy: orderBy.map((o) => ({
      expr: (o.expr as any).node,
      direction: o.direction ?? "ASC",
    })),
  })
}

/**
 * Row-value tuple for comparisons.
 *
 * ```ts
 * // (a, b) = (1, 2)
 * tuple(cols.a.toExpr(), cols.b.toExpr())
 * ```
 */
export function tuple(...exprs: Expression<any>[]): Expression<any> {
  const node: TupleNode = {
    type: "tuple",
    elements: exprs.map((e) => (e as any).node),
  }
  return wrap(node)
}

/**
 * Attach FILTER (WHERE ...) to an aggregate expression.
 *
 * ```ts
 * filter(count(), ({ active }) => active.eq(true))
 * // COUNT(*) FILTER (WHERE "active" = $1)
 * ```
 */
export function filter<T>(agg: Expression<T>, condition: Expression<boolean>): Expression<T> {
  const fnNode = (agg as any).node as FunctionCallNode
  return wrap<T>({ ...fnNode, filter: (condition as any).node })
}
