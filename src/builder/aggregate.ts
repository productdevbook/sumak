/**
 * Aggregate function builders. Split out of `eb.ts` so the public
 * expression surface can grow without the file ballooning past
 * scrolling tolerance. Every symbol here is also re-exported from
 * `eb.ts` for back-compat — existing imports keep working.
 *
 * The runtime helpers are kept duck-typed (no `instanceof Col`) so
 * this file has no dependency on `eb.ts`, breaking what would
 * otherwise be a circular import.
 */
import { fn as rawFn, lit as rawLit, star as rawStar } from "../ast/expression.ts"
import type { ExpressionNode, FunctionCallNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { brandExpression, isExpression } from "../ast/typed-expression.ts"

function wrap<T>(node: ExpressionNode): Expression<T> {
  return brandExpression<T>(node)
}

/**
 * Pull the AST node out of any of the three shapes the public
 * aggregate API accepts:
 * - `Expression<T>` (branded via `isExpression`)
 * - a `Col<T>` instance (carries `_node`)
 * - anything else is a logic bug — caller passed a raw JS value
 *   where an expression was required.
 *
 * Duck-typed so this module doesn't import the `Col` class.
 */
function exprNode(value: unknown): ExpressionNode {
  if (isExpression(value)) return (value as Expression<unknown>).node
  if (typeof value === "object" && value !== null && "_node" in value) {
    return (value as { _node: ExpressionNode })._node
  }
  throw new TypeError(
    "Aggregate argument must be an Expression or Col. Wrap raw values in val()/col().",
  )
}

/**
 * `COUNT(*)` (no argument) or `COUNT(expr)` (one argument).
 *
 * `COUNT(*)` counts every row including nulls; `COUNT(col)` counts
 * only rows where `col IS NOT NULL`. The two are semantically
 * different — picking the right one matters.
 */
export function count(): Expression<number>
export function count<T>(expr: Expression<T> | { _node: ExpressionNode }): Expression<number>
export function count<T>(expr?: Expression<T> | { _node: ExpressionNode }): Expression<number> {
  if (expr === undefined) return wrap(rawFn("COUNT", [rawStar()]))
  return wrap(rawFn("COUNT", [exprNode(expr)]))
}

/**
 * `COUNT(DISTINCT expr)` — counts unique non-null values. Sub-linear
 * cost on indexed columns; expensive on unindexed text. Returns 0
 * (not NULL) for an empty set, unlike `SUM` / `AVG` / `MIN` / `MAX`.
 *
 * ```ts
 * db.selectFrom("orders").select({ uniqueCustomers: countDistinct(typedCol("customer_id")) })
 * // SELECT COUNT(DISTINCT "customer_id") AS "uniqueCustomers" FROM "orders"
 * ```
 */
export function countDistinct(expr: Expression<any>): Expression<number> {
  const node: FunctionCallNode = {
    type: "function_call",
    name: "COUNT",
    args: [(expr as any).node],
    distinct: true,
  }
  return wrap(node)
}

/**
 * `SUM(expr)` aggregate.
 *
 * Returns `NULL` (not `0`) when no rows match the WHERE clause — `SUM`
 * over an empty set is `NULL` per SQL three-valued logic. Use
 * `coalesce(sum(...), val(0))` if you want a numeric default.
 *
 * ```ts
 * db.selectFrom("orders").select({ total: sum(typedCol<number>("amount")) })
 * // SELECT SUM("amount") AS "total" FROM "orders"
 * ```
 */
export function sum(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("SUM", [(expr as any).node]))
}

/**
 * `SUM(DISTINCT expr)` — only adds each distinct value once. Useful
 * when the same value can appear in multiple rows but should only
 * contribute one to the total.
 */
export function sumDistinct(expr: Expression<number>): Expression<number> {
  const node: FunctionCallNode = {
    type: "function_call",
    name: "SUM",
    args: [(expr as any).node],
    distinct: true,
  }
  return wrap(node)
}

/**
 * `AVG(expr)` aggregate.
 *
 * Returns `NULL` for an empty set. Numeric type promotion is dialect-
 * specific: PG and SQLite return DOUBLE for integer columns; MySQL
 * preserves DECIMAL precision. Use an explicit `cast()` if you need
 * cross-dialect-stable output.
 */
export function avg(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("AVG", [(expr as any).node]))
}

/** `AVG(DISTINCT expr)` — only averages each distinct value once. */
export function avgDistinct(expr: Expression<number>): Expression<number> {
  const node: FunctionCallNode = {
    type: "function_call",
    name: "AVG",
    args: [(expr as any).node],
    distinct: true,
  }
  return wrap(node)
}

/**
 * `MIN(expr)` aggregate. Returns the smallest non-null value, or
 * `NULL` for an empty set. Works on every comparable column type:
 * numeric, text, timestamp, date.
 */
export function min<T>(expr: Expression<T>): Expression<T> {
  return wrap(rawFn("MIN", [(expr as any).node]))
}

/**
 * `MAX(expr)` aggregate. Returns the largest non-null value, or
 * `NULL` for an empty set. See `min()` for the comparable-column-type
 * note.
 */
export function max<T>(expr: Expression<T>): Expression<T> {
  return wrap(rawFn("MAX", [(expr as any).node]))
}

/**
 * `ANY_VALUE(expr)` aggregate — returns an arbitrary non-null value
 * from the group. SQL:2023 standard, also supported on PG 16+,
 * MySQL 8, SQLite. Useful when a column is functionally dependent on
 * the GROUP BY keys but isn't itself in `GROUP BY` (the optimizer
 * already knows the value is constant per group).
 *
 * ```ts
 * db.selectFrom("orders")
 *   .select({ customer_id: typedCol("customer_id"), city: anyValue(typedCol("city")) })
 *   .groupBy("customer_id")
 * // SELECT "customer_id", ANY_VALUE("city") AS "city" FROM "orders" GROUP BY "customer_id"
 * ```
 *
 * The pick is **unspecified** — different rows may surface across
 * runs. Use `min()` / `max()` if you need a deterministic value.
 */
export function anyValue<T>(expr: Expression<T>): Expression<T> {
  return wrap(rawFn("ANY_VALUE", [exprNode(expr)]))
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

/**
 * `JSON_AGG(expr)` — aggregate rows into a JSON array. **PG-only**;
 * MySQL has `JSON_ARRAYAGG`, SQLite has `json_group_array`, MSSQL
 * has nothing equivalent. Reach for `stringAgg` or build the array
 * in application code for portability.
 *
 * Often paired with `over(...)` for windowed aggregation, or with
 * `groupBy` for row-grouping.
 */
export function jsonAgg<T>(expr: Expression<T>): Expression<T[]> {
  return wrap(rawFn("JSON_AGG", [(expr as any).node]))
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

/**
 * `PERCENTILE_CONT(fraction)` — continuous percentile (interpolates
 * between the two values straddling the requested fraction). Must be
 * paired with {@link withinGroup} to specify the ordering column;
 * unpaired calls emit `PERCENTILE_CONT(0.5)` which every dialect
 * rejects at runtime.
 *
 * ```ts
 * withinGroup(percentileCont(0.5), [{ expr: typedCol("response_ms") }])
 * // PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "response_ms" ASC)
 * ```
 *
 * Supported on PG, MySQL 8, MSSQL. SQLite has no equivalent.
 */
export function percentileCont(fraction: number): Expression<number> {
  return wrap(rawFn("PERCENTILE_CONT", [rawLit(fraction)]))
}

/**
 * `PERCENTILE_DISC(fraction)` — discrete percentile (picks an actual
 * value from the dataset, no interpolation). See {@link percentileCont}
 * for the surrounding `WITHIN GROUP` pattern.
 */
export function percentileDisc(fraction: number): Expression<number> {
  return wrap(rawFn("PERCENTILE_DISC", [rawLit(fraction)]))
}

/**
 * Attach `WITHIN GROUP (ORDER BY …)` to an ordered-set aggregate.
 * This is the SQL standard clause for inverse-distribution aggregates
 * like `PERCENTILE_CONT` / `PERCENTILE_DISC` / `MODE` — structurally
 * separate from the inline-arg-list ORDER BY that `STRING_AGG` and
 * `ARRAY_AGG` use (see {@link aggOrderBy}).
 *
 * ```ts
 * withinGroup(percentileCont(0.5), [{ expr: typedCol("response_ms") }])
 * // PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "response_ms" ASC)
 * ```
 */
export function withinGroup<T>(
  agg: Expression<T>,
  orderBy: { expr: Expression<any>; direction?: "ASC" | "DESC" }[],
): Expression<T> {
  const fnNode = (agg as any).node as FunctionCallNode
  return wrap<T>({
    ...fnNode,
    withinGroup: orderBy.map((o) => ({
      expr: (o.expr as any).node,
      direction: o.direction ?? "ASC",
    })),
  })
}

// ─── Statistical / regression aggregates ──────────────────────────────
//
// Univariate dispersion (`STDDEV`, `VARIANCE`, plus the explicit `_POP`
// and `_SAMP` forms) is supported on every relational dialect we care
// about — PG, MySQL, SQLite, MSSQL. Bivariate / linear-regression
// aggregates (`CORR`, `COVAR_*`, `REGR_*`) are SQL standard but only PG
// and MSSQL implement the full set; MySQL and SQLite refuse via the
// dialect printers using the `LINEAR_REGRESSION_AGG` feature flag.
//
// Every function returns `NULL` for an empty input set per SQL three-
// valued logic. Sample-vs-population variants follow the standard:
// `_SAMP` divides by `n − 1`, `_POP` divides by `n`. SQLite's STDEV/
// VARIANCE use the same formulas but return NULL for < 2 rows in the
// sample variants; the others return 0.
//
// All bivariate helpers take `(y, x)` — dependent variable first — per
// the SQL standard, matching the order PG's docs and the ISO grammar
// use. Swapping the order changes the regression slope/intercept.

/**
 * `STDDEV(expr)` — sample standard deviation (`STDDEV_SAMP`). Supported
 * on PG, MySQL, SQLite, MSSQL. Returns `NULL` for an empty set; on
 * SQLite the sample variants also return `NULL` for fewer than two
 * rows (the n−1 denominator would be zero).
 *
 * ```ts
 * db.selectFrom("requests").select({ jitter: stddev(typedCol("latency_ms")) })
 * // SELECT STDDEV("latency_ms") AS "jitter" FROM "requests"
 * ```
 */
export function stddev(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("STDDEV", [exprNode(expr)]))
}

/**
 * `STDDEV_SAMP(expr)` — sample standard deviation, explicit name.
 * Aliased to {@link stddev} on most dialects but emitted as the SQL
 * standard spelling so the intent is unambiguous in generated SQL.
 * PG, MySQL, SQLite, MSSQL accept the spelling.
 */
export function stddevSamp(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("STDDEV_SAMP", [exprNode(expr)]))
}

/**
 * `STDDEV_POP(expr)` — population standard deviation. Divides by `n`
 * rather than `n − 1`. Use this when the data is the entire population
 * (not a sample). PG, MySQL, SQLite, MSSQL accept the spelling.
 */
export function stddevPop(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("STDDEV_POP", [exprNode(expr)]))
}

/**
 * `VARIANCE(expr)` — sample variance (`VAR_SAMP`). Supported on PG,
 * MySQL, SQLite, MSSQL. Returns `NULL` for an empty set; on SQLite the
 * sample variants also return `NULL` for fewer than two rows.
 *
 * ```ts
 * db.selectFrom("requests").select({ jitterSq: variance(typedCol("latency_ms")) })
 * // SELECT VARIANCE("latency_ms") AS "jitterSq" FROM "requests"
 * ```
 */
export function variance(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("VARIANCE", [exprNode(expr)]))
}

/**
 * `VAR_SAMP(expr)` — sample variance, explicit name. Aliased to
 * {@link variance} on most dialects but emitted as the SQL standard
 * spelling. PG, MySQL, SQLite, MSSQL accept the spelling.
 */
export function varianceSamp(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("VAR_SAMP", [exprNode(expr)]))
}

/**
 * `VAR_POP(expr)` — population variance. Divides by `n` rather than
 * `n − 1`. Use when the data is the entire population. PG, MySQL,
 * SQLite, MSSQL accept the spelling.
 */
export function variancePop(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("VAR_POP", [exprNode(expr)]))
}

/**
 * `CORR(y, x)` — Pearson correlation coefficient between two
 * expressions. Returns a value in `[-1, 1]`, or `NULL` for an empty
 * set / single-row input. **PG and MSSQL only**; MySQL and SQLite have
 * no equivalent and the printers throw at compile time.
 *
 * The argument order is `(dependent, independent)` per the SQL
 * standard — the same order PG's docs use. Swapping has no effect on
 * the magnitude of `CORR` but does flip the sign convention of paired
 * regression helpers (`REGR_SLOPE`, etc.).
 *
 * ```ts
 * db.selectFrom("ads").select({ ctr_vs_spend: corr(typedCol("ctr"), typedCol("spend")) })
 * // SELECT CORR("ctr", "spend") AS "ctr_vs_spend" FROM "ads"
 * ```
 */
export function corr(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("CORR", [exprNode(y), exprNode(x)]))
}

/**
 * `COVAR_POP(y, x)` — population covariance. Divides by `n`. **PG and
 * MSSQL only**; refuses on MySQL/SQLite. See {@link corr} for argument
 * ordering.
 */
export function covarPop(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("COVAR_POP", [exprNode(y), exprNode(x)]))
}

/**
 * `COVAR_SAMP(y, x)` — sample covariance. Divides by `n − 1`. **PG and
 * MSSQL only**; refuses on MySQL/SQLite.
 */
export function covarSamp(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("COVAR_SAMP", [exprNode(y), exprNode(x)]))
}

/**
 * `REGR_SLOPE(y, x)` — slope of the least-squares linear regression
 * line fit to the `(x, y)` pairs. **PG and MSSQL only**; refuses on
 * MySQL/SQLite.
 *
 * Argument order matches the SQL standard: `(dependent, independent)`,
 * which is the opposite of the `y = mx + b` notation but matches the
 * grammar `REGR_SLOPE(<y>, <x>)`.
 */
export function regrSlope(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("REGR_SLOPE", [exprNode(y), exprNode(x)]))
}

/**
 * `REGR_INTERCEPT(y, x)` — y-intercept of the least-squares regression
 * line. **PG and MSSQL only**; refuses on MySQL/SQLite.
 */
export function regrIntercept(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("REGR_INTERCEPT", [exprNode(y), exprNode(x)]))
}

/**
 * `REGR_R2(y, x)` — coefficient of determination (R²) of the
 * least-squares regression. Returns a value in `[0, 1]`. **PG and
 * MSSQL only**; refuses on MySQL/SQLite.
 */
export function regrR2(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("REGR_R2", [exprNode(y), exprNode(x)]))
}
