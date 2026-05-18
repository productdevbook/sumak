import {
  and as rawAnd,
  between as rawBetween,
  binOp as rawBinOp,
  col as rawCol,
  eq as rawEq,
  gt as rawGt,
  gte as rawGte,
  inList as rawInList,
  isNull as rawIsNull,
  like as rawLike,
  lit as rawLit,
  lt as rawLt,
  lte as rawLte,
  neq as rawNeq,
  not as rawNot,
  or as rawOr,
  param as rawParam,
} from "./expression.ts"
import type { ExpressionNode } from "./nodes.ts"

/**
 * Runtime brand used by `isExpression()` to distinguish
 * `{ node: ExpressionNode }` expression wrappers from arbitrary user
 * objects (e.g. a JSON column value that happens to have a `.node` key).
 *
 * The symbol is NOT exported — external code cannot forge this brand.
 */
const EXPRESSION_BRAND: unique symbol = Symbol("sumak.expression")

/**
 * Type-safe expression wrapper. The T parameter tracks the expression's
 * output type at compile time. At runtime, this is an `{ node }` object
 * with a hidden brand symbol for reliable `isExpression()` detection.
 *
 * The `__type` field is a phantom — it never exists at runtime.
 */
export interface Expression<T> {
  readonly __type: T
  readonly node: ExpressionNode
  readonly [EXPRESSION_BRAND]?: true
}

/**
 * Wrap a raw AST node as a typed, branded Expression. Exported so other
 * internal builders (`eb.ts`, etc.) can produce Expressions that pass the
 * `isExpression()` runtime check.
 *
 * @internal
 */
export function brandExpression<T>(node: ExpressionNode): Expression<T> {
  return { node, [EXPRESSION_BRAND]: true } as Expression<T>
}

function expr<T>(node: ExpressionNode): Expression<T> {
  return brandExpression<T>(node)
}

/**
 * Runtime check — does this value look like an Expression?
 *
 * Used by APIs that accept `T | Expression<T>` (e.g. `.set({ col: val })`
 * where `val` may be a plain JavaScript value OR an expression) to branch
 * safely. Uses a hidden Symbol brand so it cannot be confused with user
 * objects that happen to have a `.node` property.
 */
export function isExpression(value: unknown): value is Expression<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any)[EXPRESSION_BRAND] === true &&
    typeof (value as any).node === "object"
  )
}

/** Unwrap an Expression to its underlying AST node */
export function unwrap<T>(e: Expression<T>): ExpressionNode {
  return e.node
}

/**
 * Runtime guard used by typed-builder `.where()` / `.orWhere()` /
 * `.having()`. Accepts a value that *should* be an `Expression<boolean>`
 * — the result of either a callback invocation or a direct expression
 * argument — and returns its AST node. Throws a TypeError with a hint
 * when the value is a primitive (string / number / boolean / null /
 * undefined) instead of an expression wrapper.
 *
 * Why this exists: TypeScript types are erased at runtime, so calling
 * `.where("id", "=", 42)` (kysely-style) passes `"id"` as the first
 * argument and silently drops the comparison. The underlying builder
 * stored `undefined` as the predicate and the printer omitted the
 * WHERE clause entirely — a silent bug that turns row-scoped DELETEs
 * into table-wide DELETEs. This guard turns that into a loud failure.
 *
 * The check is intentionally looser than `isExpression()`: it accepts
 * any object with a `.node` field that looks like an AST node, even
 * when the expression brand symbol is missing. That keeps the sql``
 * template (which returns plain `{ node }` objects) and hand-rolled
 * AST nodes working without forcing every internal Expression to be
 * branded.
 */
export function unwrapPredicate(value: unknown, method: string): ExpressionNode {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { node?: unknown }).node === "object" &&
    (value as { node: unknown }).node !== null &&
    typeof (value as { node: { type?: unknown } }).node.type === "string"
  ) {
    return (value as Expression<unknown>).node
  }
  const got =
    typeof value === "string"
      ? `string "${value.slice(0, 40)}"${value.length > 40 ? "…" : ""}`
      : typeof value === "number" || typeof value === "boolean"
        ? `${typeof value} (${String(value)})`
        : value === null
          ? "null"
          : value === undefined
            ? "undefined"
            : typeof value
  // Strip "()" or "(callback)" from method name so the example below
  // reads `.where(({ col }) => …)`, not `.where(()({ col }) => …)`.
  const bare = method.replace(/\([^)]*\)$/, "")
  throw new TypeError(
    `${method} expected an Expression<boolean> or a callback returning one. Got ${got}. ` +
      `Use the callback form: ${bare}(({ col }) => col.eq(value))`,
  )
}

/** Reference a column — type-safe version */
export function typedCol<T>(column: string, table?: string): Expression<T> {
  return expr<T>(rawCol(column, table))
}

/** Wrap a literal value */
export function typedLit<T extends string | number | boolean | null>(value: T): Expression<T> {
  return expr<T>(rawLit(value))
}

/** Wrap a parameter value */
export function typedParam<T>(index: number, value: T): Expression<T> {
  return expr<T>(rawParam(index, value))
}

// Comparison operators — enforce matching types

export function typedEq<T>(left: Expression<T>, right: Expression<T>): Expression<boolean> {
  return expr<boolean>(rawEq(left.node, right.node))
}

export function typedNeq<T>(left: Expression<T>, right: Expression<T>): Expression<boolean> {
  return expr<boolean>(rawNeq(left.node, right.node))
}

export function typedGt<T>(left: Expression<T>, right: Expression<T>): Expression<boolean> {
  return expr<boolean>(rawGt(left.node, right.node))
}

export function typedGte<T>(left: Expression<T>, right: Expression<T>): Expression<boolean> {
  return expr<boolean>(rawGte(left.node, right.node))
}

export function typedLt<T>(left: Expression<T>, right: Expression<T>): Expression<boolean> {
  return expr<boolean>(rawLt(left.node, right.node))
}

export function typedLte<T>(left: Expression<T>, right: Expression<T>): Expression<boolean> {
  return expr<boolean>(rawLte(left.node, right.node))
}

export function typedLike(
  left: Expression<string>,
  right: Expression<string>,
): Expression<boolean> {
  return expr<boolean>(rawLike(left.node, right.node))
}

export function typedBetween<T>(
  value: Expression<T>,
  low: Expression<T>,
  high: Expression<T>,
): Expression<boolean> {
  return expr<boolean>(rawBetween(value.node, low.node, high.node))
}

export function typedIn<T>(value: Expression<T>, list: Expression<T>[]): Expression<boolean> {
  return expr<boolean>(
    rawInList(
      value.node,
      list.map((e) => e.node),
    ),
  )
}

export function typedIsNull<T>(value: Expression<T>): Expression<boolean> {
  return expr<boolean>(rawIsNull(value.node))
}

export function typedIsNotNull<T>(value: Expression<T>): Expression<boolean> {
  return expr<boolean>(rawIsNull(value.node, true))
}

// Logical operators — enforce boolean operands

export function typedAnd(
  left: Expression<boolean>,
  right: Expression<boolean>,
): Expression<boolean> {
  return expr<boolean>(rawAnd(left.node, right.node))
}

export function typedOr(
  left: Expression<boolean>,
  right: Expression<boolean>,
): Expression<boolean> {
  return expr<boolean>(rawOr(left.node, right.node))
}

export function typedNot(operand: Expression<boolean>): Expression<boolean> {
  return expr<boolean>(rawNot(operand.node))
}

// Arithmetic — enforce numeric operands

export function typedAdd(left: Expression<number>, right: Expression<number>): Expression<number> {
  return expr<number>(rawBinOp("+", left.node, right.node))
}

export function typedSub(left: Expression<number>, right: Expression<number>): Expression<number> {
  return expr<number>(rawBinOp("-", left.node, right.node))
}

export function typedMul(left: Expression<number>, right: Expression<number>): Expression<number> {
  return expr<number>(rawBinOp("*", left.node, right.node))
}

export function typedDiv(left: Expression<number>, right: Expression<number>): Expression<number> {
  return expr<number>(rawBinOp("/", left.node, right.node))
}
