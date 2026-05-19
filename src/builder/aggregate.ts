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
