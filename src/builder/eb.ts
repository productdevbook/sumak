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
import { validateFunctionName } from "../utils/security.ts"

/**
 * A typed column reference that exposes comparison methods.
 *
 * ```ts
 * // users.id.eq(42) → ("id" = $1) with param [42]
 * // users.name.like("%ali%") → ("name" LIKE '%ali%')
 * ```
 */
/**
 * Accepted RHS for a Col comparison: raw value, another Col, or Expression.
 * This is what unifies the v0.1 `.eq(x)` overload surface — no more `.eqCol` / `.eqExpr`.
 */
export type CmpArg<T> = T | Col<T> | Expression<T>

function rhsNode<T>(value: CmpArg<T>): ExpressionNode {
  if (value instanceof Col) return (value as Col<T>)._node
  if (
    value !== null &&
    typeof value === "object" &&
    "node" in (value as any) &&
    (value as any).node != null
  ) {
    return (value as any).node as ExpressionNode
  }
  return autoParam(value)
}

export class Col<T> {
  /** @internal */
  readonly _node: ExpressionNode
  declare readonly _type: T

  constructor(column: string, table?: string) {
    this._node = rawCol(column, table)
  }

  /** = — accepts raw value, another Col, or Expression. */
  eq(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp("=", this._node, rhsNode(value)))
  }

  /** != */
  neq(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp("!=", this._node, rhsNode(value)))
  }

  /** > */
  gt(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp(">", this._node, rhsNode(value)))
  }

  /** >= */
  gte(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp(">=", this._node, rhsNode(value)))
  }

  /** < */
  lt(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp("<", this._node, rhsNode(value)))
  }

  /** <= */
  lte(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp("<=", this._node, rhsNode(value)))
  }

  /**
   * LIKE / ILIKE / NOT LIKE / NOT ILIKE — one method, opts for variants.
   * Pattern is always parameterized.
   */
  like(
    this: Col<string>,
    pattern: string,
    opts?: { negate?: boolean; insensitive?: boolean },
  ): Expression<boolean> {
    const op =
      opts?.negate === true
        ? opts?.insensitive === true
          ? "NOT ILIKE"
          : "NOT LIKE"
        : opts?.insensitive === true
          ? "ILIKE"
          : "LIKE"
    return wrap(binOp(op, this._node, autoParam(pattern)))
  }

  /** IN (...values) / NOT IN via `{ negate: true }`. Also accepts a SELECT subquery. */
  in(values: T[] | SelectNode, opts?: { negate?: boolean }): Expression<boolean> {
    const negated = opts?.negate === true
    if (Array.isArray(values)) {
      return wrap({
        type: "in",
        expr: this._node,
        values: values.map((v) => autoParam(v)),
        negated,
      })
    }
    return wrap({ type: "in", expr: this._node, values, negated })
  }

  /** IS NULL / IS NOT NULL via `{ negate: true }`. */
  isNull(opts?: { negate?: boolean }): Expression<boolean> {
    return wrap({ type: "is_null", expr: this._node, negated: opts?.negate === true })
  }

  /** BETWEEN / NOT BETWEEN / BETWEEN SYMMETRIC — one method, opts for variants. */
  between(
    low: CmpArg<T>,
    high: CmpArg<T>,
    opts?: { negate?: boolean; symmetric?: boolean },
  ): Expression<boolean> {
    return wrap({
      type: "between",
      expr: this._node,
      low: rhsNode(low),
      high: rhsNode(high),
      negated: opts?.negate === true,
      symmetric: opts?.symmetric === true,
    })
  }

  /**
   * IS DISTINCT FROM — null-safe comparison.
   * Pass `{ negate: true }` for IS NOT DISTINCT FROM.
   */
  distinctFrom(value: T | null, opts?: { negate?: boolean }): Expression<boolean> {
    const op = opts?.negate === true ? "IS NOT DISTINCT FROM" : "IS DISTINCT FROM"
    return wrap(binOp(op, this._node, autoParam(value)))
  }

  /** As raw Expression<T> for advanced use */
  toExpr(): Expression<T> {
    return wrap<T>(this._node)
  }

  /** CAST(col AS dataType) inline */
  cast<R>(dataType: string): Expression<R> {
    return wrap<R>(rawCast(this._node, dataType))
  }

  /** ASC ordering — for use with orderBy(col.asc()) */
  asc(): { expr: Expression<T>; direction: "ASC" } {
    return { expr: wrap<T>(this._node), direction: "ASC" }
  }

  /** DESC ordering — for use with orderBy(col.desc()) */
  desc(): { expr: Expression<T>; direction: "DESC" } {
    return { expr: wrap<T>(this._node), direction: "DESC" }
  }

  // ─── Legacy methods (kept for backwards compatibility; scheduled for removal) ───
  /** @deprecated Use `.like(pattern, { negate: true })`. */
  notLike(this: Col<string>, pattern: string): Expression<boolean> {
    return this.like(pattern, { negate: true })
  }
  /** @deprecated Use `.like(pattern, { insensitive: true })`. */
  ilike(this: Col<string>, pattern: string): Expression<boolean> {
    return this.like(pattern, { insensitive: true })
  }
  /** @deprecated Use `.like(pattern, { negate: true, insensitive: true })`. */
  notIlike(this: Col<string>, pattern: string): Expression<boolean> {
    return this.like(pattern, { negate: true, insensitive: true })
  }
  /** @deprecated Use `.in(values, { negate: true })`. */
  notIn(values: T[]): Expression<boolean> {
    return this.in(values, { negate: true })
  }
  /** @deprecated Use `.isNull({ negate: true })`. */
  isNotNull(): Expression<boolean> {
    return this.isNull({ negate: true })
  }
  /** @deprecated Use `.between(low, high, { negate: true })`. */
  notBetween(low: T, high: T): Expression<boolean> {
    return this.between(low, high, { negate: true })
  }
  /** @deprecated Use `.between(low, high, { symmetric: true })`. */
  betweenSymmetric(low: T, high: T): Expression<boolean> {
    return this.between(low, high, { symmetric: true })
  }
  /** @deprecated Use `.in(subquery)`. */
  inSubquery(query: SelectNode): Expression<boolean> {
    return this.in(query)
  }
  /** @deprecated Use `.in(subquery, { negate: true })`. */
  notInSubquery(query: SelectNode): Expression<boolean> {
    return this.in(query, { negate: true })
  }
  /** @deprecated Use `.distinctFrom(value)`. */
  isDistinctFrom(value: T): Expression<boolean> {
    return this.distinctFrom(value)
  }
  /** @deprecated Use `.distinctFrom(value, { negate: true })`. */
  isNotDistinctFrom(value: T): Expression<boolean> {
    return this.distinctFrom(value, { negate: true })
  }
  /** @deprecated Use `.eq(expr)` — Col and Expression are now unified. */
  eqExpr(value: Expression<T>): Expression<boolean> {
    return this.eq(value)
  }
  /** @deprecated Use `.neq(expr)`. */
  neqExpr(value: Expression<T>): Expression<boolean> {
    return this.neq(value)
  }
  /** @deprecated Use `.gt(expr)`. */
  gtExpr(value: Expression<T>): Expression<boolean> {
    return this.gt(value)
  }
  /** @deprecated Use `.gte(expr)`. */
  gteExpr(value: Expression<T>): Expression<boolean> {
    return this.gte(value)
  }
  /** @deprecated Use `.lt(expr)`. */
  ltExpr(value: Expression<T>): Expression<boolean> {
    return this.lt(value)
  }
  /** @deprecated Use `.lte(expr)`. */
  lteExpr(value: Expression<T>): Expression<boolean> {
    return this.lte(value)
  }
  /** @deprecated Use `.eq(otherCol)` — Col and Expression are now unified. */
  eqCol(other: Col<T>): Expression<boolean> {
    return this.eq(other)
  }
  /** @deprecated Use `.neq(otherCol)`. */
  neqCol(other: Col<T>): Expression<boolean> {
    return this.neq(other)
  }
  /** @deprecated Use `.gt(otherCol)`. */
  gtCol(other: Col<T>): Expression<boolean> {
    return this.gt(other)
  }
  /** @deprecated Use `.lt(otherCol)`. */
  ltCol(other: Col<T>): Expression<boolean> {
    return this.lt(other)
  }
  /** @deprecated Use `.gte(otherCol)`. */
  gteCol(other: Col<T>): Expression<boolean> {
    return this.gte(other)
  }
  /** @deprecated Use `.lte(otherCol)`. */
  lteCol(other: Col<T>): Expression<boolean> {
    return this.lte(other)
  }
}

// ── Internal helpers ──

function autoParam(value: unknown): ExpressionNode {
  return rawParam(0, value)
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

/** AND expressions — variadic: and(a, b) or and(a, b, c, ...) */
export function and(...exprs: Expression<boolean>[]): Expression<boolean> {
  if (exprs.length === 0) return wrap(rawLit(true))
  if (exprs.length === 1) return exprs[0]!
  return exprs.reduce((acc, expr) => wrap(rawAnd((acc as any).node, (expr as any).node)))
}

/** OR expressions — variadic: or(a, b) or or(a, b, c, ...) */
export function or(...exprs: Expression<boolean>[]): Expression<boolean> {
  if (exprs.length === 0) return wrap(rawLit(false))
  if (exprs.length === 1) return exprs[0]!
  return exprs.reduce((acc, expr) => wrap(rawOr((acc as any).node, (expr as any).node)))
}

/** Raw literal value as expression */
export function val<T extends string | number | boolean | null>(value: T): Expression<T> {
  return wrap<T>(rawLit(value))
}

/**
 * Unsafe raw SQL expression — escape hatch for arbitrary SQL in expressions.
 *
 * **WARNING:** Never pass user-controlled input as the SQL string.
 * This bypasses all security validation and can lead to SQL injection.
 *
 * ```ts
 * .where(() => unsafeRawExpr("age > 18"))
 * .selectExpr(unsafeRawExpr<number>("EXTRACT(YEAR FROM created_at)"), "year")
 * ```
 */
export function unsafeRawExpr<T = unknown>(sql: string, params: unknown[] = []): Expression<T> {
  return wrap<T>({ type: "raw", sql, params })
}

/**
 * SQL function call with name validation.
 * Function names must be alphanumeric identifiers (prevents injection).
 * For non-standard function names, use `unsafeSqlFn()` with caution.
 */
export function sqlFn(name: string, ...args: Expression<any>[]): Expression<any> {
  validateFunctionName(name)
  return wrap(
    rawFn(
      name,
      args.map((a) => (a as any).node),
    ),
  )
}

/**
 * Unsafe SQL function call — no name validation.
 *
 * **WARNING:** Never pass user-controlled input as the function name.
 * This bypasses security validation and can lead to SQL injection.
 */
export function unsafeSqlFn(name: string, ...args: Expression<any>[]): Expression<any> {
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

/** COALESCE(a, b, c, ...) — returns first non-null value */
export function coalesce<T>(...args: Expression<T | null>[]): Expression<T> {
  return wrap(
    rawFn(
      "COALESCE",
      args.map((a) => (a as any).node),
    ),
  )
}

/** NOT expr */
export function not(expr: Expression<boolean>): Expression<boolean> {
  return wrap(rawNot((expr as any).node))
}

/** Add: a + b */
export function add(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("+", (a as any).node, (b as any).node))
}

/** Subtract: a - b */
export function sub(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("-", (a as any).node, (b as any).node))
}

/** Multiply: a * b */
export function mul(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("*", (a as any).node, (b as any).node))
}

/** Divide: a / b */
export function div(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("/", (a as any).node, (b as any).node))
}

/** Modulo: a % b */
export function mod(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("%", (a as any).node, (b as any).node))
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

/** Wrap a SELECT query as a scalar subquery expression. */
export function subqueryExpr<T>(query: SelectNode): Expression<T> {
  return wrap<T>({ type: "subquery", query })
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

/** JSON_AGG(expr) — aggregate rows into JSON array (PG) */
export function jsonAgg<T>(expr: Expression<T>): Expression<T[]> {
  return wrap(rawFn("JSON_AGG", [(expr as any).node]))
}

/** TO_JSON(expr) — convert value to JSON (PG) */
export function toJson<T>(expr: Expression<T>): Expression<unknown> {
  return wrap(rawFn("TO_JSON", [(expr as any).node]))
}

/** JSON_BUILD_OBJECT(key, value, ...) — build JSON object (PG) */
export function jsonBuildObject(
  ...pairs: [string, Expression<any>][]
): Expression<Record<string, unknown>> {
  const args: ExpressionNode[] = []
  for (const [key, val] of pairs) {
    args.push(rawLit(key))
    args.push((val as any).node)
  }
  return wrap(rawFn("JSON_BUILD_OBJECT", args))
}

// ── PostgreSQL array operators ──

/** @> (array contains) */
export function arrayContains(arr: Expression<any>, values: Expression<any>): Expression<boolean> {
  return wrap(binOp("@>", (arr as any).node, (values as any).node))
}

/** <@ (array contained by) */
export function arrayContainedBy(
  arr: Expression<any>,
  values: Expression<any>,
): Expression<boolean> {
  return wrap(binOp("<@", (arr as any).node, (values as any).node))
}

/** && (array overlaps) */
export function arrayOverlaps(arr: Expression<any>, values: Expression<any>): Expression<boolean> {
  return wrap(binOp("&&", (arr as any).node, (values as any).node))
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
