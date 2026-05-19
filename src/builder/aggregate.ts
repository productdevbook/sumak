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
// and `_SAMP` forms) is supported on PG, MySQL, and SQLite under the
// SQL-standard names. MSSQL's T-SQL has no `STDDEV_*` / `VARIANCE_*`
// aliases — it spells them `STDEV` / `STDEVP` / `VAR` / `VARP` — and
// the printer refuses these standard names on MSSQL (use `sqlFn` with
// the T-SQL names if you need MSSQL coverage). Bivariate /
// linear-regression aggregates (`CORR`, `COVAR_*`, `REGR_*`) are
// SQL-standard but only PG implements them natively; MSSQL/MySQL/SQLite
// all refuse via the `LINEAR_REGRESSION_AGG` feature flag.
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
 * on PG, MySQL, and SQLite. Returns `NULL` for an empty set; on
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
 * PG, MySQL, and SQLite accept the spelling; MSSQL's T-SQL has no `STDDEV_*` / `VARIANCE_*` aliases (it uses `STDEV` / `STDEVP` / `VAR` / `VARP`) so the printer refuses on MSSQL — reach for `sqlFn(...)` with the T-SQL names.
 */
export function stddevSamp(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("STDDEV_SAMP", [exprNode(expr)]))
}

/**
 * `STDDEV_POP(expr)` — population standard deviation. Divides by `n`
 * rather than `n − 1`. Use this when the data is the entire population
 * (not a sample). PG, MySQL, and SQLite accept the spelling; MSSQL's T-SQL has no `STDDEV_*` / `VARIANCE_*` aliases (it uses `STDEV` / `STDEVP` / `VAR` / `VARP`) so the printer refuses on MSSQL — reach for `sqlFn(...)` with the T-SQL names.
 */
export function stddevPop(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("STDDEV_POP", [exprNode(expr)]))
}

/**
 * `VARIANCE(expr)` — sample variance (`VAR_SAMP`). Supported on PG,
 * MySQL, and SQLite. MSSQL is excluded — its T-SQL uses `VAR` / `VARP`
 * with no `VARIANCE_*` alias. Returns `NULL` for an empty set; on
 * SQLite the sample variants also return `NULL` for fewer than two
 * rows.
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
 * spelling. PG, MySQL, and SQLite accept the spelling; MSSQL's T-SQL has no `STDDEV_*` / `VARIANCE_*` aliases (it uses `STDEV` / `STDEVP` / `VAR` / `VARP`) so the printer refuses on MSSQL — reach for `sqlFn(...)` with the T-SQL names.
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
 * set / single-row input. **PG only**. MSSQL has no built-in
 * regression aggregates either (only `STDEV`/`VARP` univariate ones);
 * MySQL and SQLite likewise lack them. All three throw at compile time.
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
 * `COVAR_POP(y, x)` — population covariance. Divides by `n`. **PG only**; refuses on MSSQL/MySQL/SQLite. See {@link corr} for argument
 * ordering.
 */
export function covarPop(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("COVAR_POP", [exprNode(y), exprNode(x)]))
}

/**
 * `COVAR_SAMP(y, x)` — sample covariance. Divides by `n − 1`. **PG only**; refuses on MSSQL/MySQL/SQLite.
 */
export function covarSamp(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("COVAR_SAMP", [exprNode(y), exprNode(x)]))
}

/**
 * `REGR_SLOPE(y, x)` — slope of the least-squares linear regression
 * line fit to the `(x, y)` pairs. **PG only**; refuses on MSSQL/MySQL/SQLite.
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
 * line. **PG only**; refuses on MSSQL/MySQL/SQLite.
 */
export function regrIntercept(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("REGR_INTERCEPT", [exprNode(y), exprNode(x)]))
}

/**
 * `REGR_R2(y, x)` — coefficient of determination (R²) of the
 * least-squares regression. Returns a value in `[0, 1]`. **PG only**; refuses on MSSQL/MySQL/SQLite.
 */
export function regrR2(y: Expression<number>, x: Expression<number>): Expression<number> {
  return wrap(rawFn("REGR_R2", [exprNode(y), exprNode(x)]))
}

// ─── Bitwise aggregate functions ──────────────────────────────────────
//
// `BIT_AND`, `BIT_OR`, `BIT_XOR` reduce a column of integers via the
// matching bitwise operator. PG ships all three (XOR was added in PG 14);
// MySQL has the full set; SQLite gained `BIT_AND` and `BIT_OR` in 3.44
// (via the math extension build, which sumak's supported SQLite version
// line includes). MSSQL has none of the three as built-ins — refuses via
// `BIT_AGGREGATES` / `BIT_XOR_AGG`.
//
// NULL handling matches `SUM`: NULL inputs are skipped, an empty set
// (or all-NULL set) returns NULL. There is no `BIT_AND DISTINCT` form —
// the bitwise reduction is order-independent, so DISTINCT would either
// be a no-op (BIT_AND, BIT_OR) or behave like a parity counter
// (BIT_XOR), neither of which has portable SQL syntax.

/**
 * `BIT_AND(expr)` — bitwise AND across every non-null input. Useful
 * for masking out bits that aren't set in every row (a "common bits"
 * fold). PG, MySQL, and SQLite (3.44+, with the math extension)
 * support the standard name. **MSSQL has no built-in equivalent** —
 * the printer refuses via the `BIT_AGGREGATES` flag.
 *
 * ```ts
 * db.selectFrom("perms").select({ everyoneHas: bitAnd(typedCol<number>("flags")) })
 * // SELECT BIT_AND("flags") AS "everyoneHas" FROM "perms"
 * ```
 */
export function bitAnd(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("BIT_AND", [exprNode(expr)]))
}

/**
 * `BIT_OR(expr)` — bitwise OR across every non-null input. Useful for
 * gathering "any-of-row-has-bit" flags into a single mask. PG, MySQL,
 * SQLite (3.44+). MSSQL is unsupported.
 *
 * ```ts
 * db.selectFrom("perms").select({ unionMask: bitOr(typedCol<number>("flags")) })
 * // SELECT BIT_OR("flags") AS "unionMask" FROM "perms"
 * ```
 */
export function bitOr(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("BIT_OR", [exprNode(expr)]))
}

/**
 * `BIT_XOR(expr)` — bitwise XOR across every non-null input. Behaves
 * like a parity fold: a bit is set in the result iff an odd number of
 * input rows have it set. **MySQL only natively**; PG added a native
 * `BIT_XOR` aggregate in version 14, but the matrix only lists MySQL
 * since older PG versions parse it as a UDF call (or fail outright).
 * SQLite and MSSQL have no equivalent. The printer refuses via the
 * `BIT_XOR_AGG` flag on PG/SQLite/MSSQL — if you're on PG 14+ and want
 * the built-in, reach for `sqlFn("BIT_XOR", expr)` directly.
 */
export function bitXor(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("BIT_XOR", [exprNode(expr)]))
}

// ─── Boolean aggregate functions ──────────────────────────────────────
//
// `BOOL_AND` / `BOOL_OR` reduce a column of booleans to a single
// boolean. PG ships both under the standard names (with `EVERY` as a
// synonym for `BOOL_AND`); SQLite added them in 3.45. MySQL has no
// equivalent — its `BIT_AND` / `BIT_OR` are bitwise, not boolean, and
// silently coerce booleans to 0/1 with no nicely-typed boolean fold.
// MSSQL also lacks the built-ins; the printer refuses on both via
// `BOOL_AGGREGATES`. The portable workaround is `MIN(CAST(b AS int))`
// (for BOOL_AND) / `MAX(CAST(b AS int))` (for BOOL_OR).

/**
 * `BOOL_AND(expr)` — TRUE iff every non-null input is TRUE. Synonym
 * of the SQL standard `EVERY(expr)`; sumak emits `BOOL_AND` for
 * consistency with `BOOL_OR`. PG and SQLite (3.45+) support the
 * standard name. **MySQL and MSSQL have no equivalent built-in** —
 * the printer refuses via the `BOOL_AGGREGATES` flag; reach for
 * `min(cast(b as int))` (or `MIN(b)` on PG with the booleans-as-ints
 * shortcut) as the portable workaround.
 *
 * ```ts
 * db.selectFrom("checks").select({ allPassed: boolAnd(typedCol<boolean>("passed")) })
 * // SELECT BOOL_AND("passed") AS "allPassed" FROM "checks"
 * ```
 */
export function boolAnd(expr: Expression<boolean>): Expression<boolean> {
  return wrap(rawFn("BOOL_AND", [exprNode(expr)]))
}

/**
 * `BOOL_OR(expr)` — TRUE iff at least one non-null input is TRUE.
 * Synonym of the SQL standard `ANY(expr)` (not to be confused with
 * the `<op> ANY (...)` quantified subquery construct, which sumak
 * exposes separately). PG and SQLite (3.45+). MySQL and MSSQL refuse
 * via `BOOL_AGGREGATES`.
 *
 * ```ts
 * db.selectFrom("checks").select({ anyPassed: boolOr(typedCol<boolean>("passed")) })
 * // SELECT BOOL_OR("passed") AS "anyPassed" FROM "checks"
 * ```
 */
export function boolOr(expr: Expression<boolean>): Expression<boolean> {
  return wrap(rawFn("BOOL_OR", [exprNode(expr)]))
}

// ─── Window-value functions ───────────────────────────────────────────
//
// `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE` are window-only — they only
// make sense inside an `OVER (...)` clause and the printer refuses bare
// calls via the `WINDOW_ONLY_FUNCTIONS` allowlist (see
// `src/printer/function-tables.ts`). `FIRST_VALUE` / `LAST_VALUE` are
// portable across PG, MySQL 8, SQLite 3.25+, MSSQL. `NTH_VALUE` is
// supported on PG, MySQL 8, SQLite 3.25+ — MSSQL has no equivalent and
// the printer refuses via `NTH_VALUE_FN`.
//
// All three honor the window frame: changing the frame from the default
// `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` to `ROWS BETWEEN
// UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` flips `LAST_VALUE` from
// "current row's value" to "actual last value in the partition" — a
// classic SQL footgun. The JSDoc on each function spells it out.

/**
 * `FIRST_VALUE(expr)` — the first value of `expr` in the window
 * frame. Must be wrapped in `over(...)`. Supported on PG, MySQL 8,
 * SQLite 3.25+, MSSQL.
 *
 * The frame matters: with the default `RANGE BETWEEN UNBOUNDED
 * PRECEDING AND CURRENT ROW` the "first value" is the first row in
 * the partition's ordering (the usual intent). Combined with an
 * unbounded-both frame it stays the same; combined with `ROWS BETWEEN
 * 1 PRECEDING AND CURRENT ROW` the "first" becomes "the prior row's
 * value" — different semantics.
 *
 * ```ts
 * over(firstValue(col("price")), w => w.partitionBy("symbol").orderBy("ts"))
 * // FIRST_VALUE("price") OVER (PARTITION BY "symbol" ORDER BY "ts")
 * ```
 */
export function firstValue<T>(expr: Expression<T>): Expression<T> {
  return wrap(rawFn("FIRST_VALUE", [exprNode(expr)]))
}

/**
 * `LAST_VALUE(expr)` — the last value of `expr` in the window frame.
 * Must be wrapped in `over(...)`. Supported on PG, MySQL 8, SQLite
 * 3.25+, MSSQL.
 *
 * **Frame-default footgun.** The default window frame is `RANGE
 * BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, which makes
 * `LAST_VALUE` return the *current* row's value (the "last" so far),
 * not the last value in the entire partition. To get the latter, set
 * an explicit frame:
 *
 * ```ts
 * over(lastValue(col("price")), w =>
 *   w.partitionBy("symbol")
 *    .orderBy("ts")
 *    .rows({ type: "unbounded_preceding" }, { type: "unbounded_following" }))
 * // LAST_VALUE("price") OVER (PARTITION BY "symbol" ORDER BY "ts"
 * //   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
 * ```
 */
export function lastValue<T>(expr: Expression<T>): Expression<T> {
  return wrap(rawFn("LAST_VALUE", [exprNode(expr)]))
}

/**
 * `NTH_VALUE(expr, n)` — the Nth value of `expr` in the window frame
 * (1-indexed). Must be wrapped in `over(...)`. Supported on PG, MySQL
 * 8, SQLite 3.25+. **MSSQL has no equivalent** — the printer refuses
 * via the `NTH_VALUE_FN` feature flag.
 *
 * Same frame-default warning as {@link lastValue}: if `n` exceeds the
 * current frame size, the result is NULL — not an out-of-bounds
 * error.
 *
 * ```ts
 * over(nthValue(col("price"), 3), w => w.partitionBy("symbol").orderBy("ts"))
 * // NTH_VALUE("price", 3) OVER (PARTITION BY "symbol" ORDER BY "ts")
 * ```
 */
export function nthValue<T>(expr: Expression<T>, n: number): Expression<T> {
  return wrap(rawFn("NTH_VALUE", [exprNode(expr), rawLit(n)]))
}
