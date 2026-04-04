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
 * Type-safe expression wrapper. The T parameter tracks the expression's
 * output type at compile time. At runtime, this is just an ExpressionNode.
 *
 * The `__type` field is a phantom — it never exists at runtime.
 */
export interface Expression<T> {
  readonly __type: T
  readonly node: ExpressionNode
}

function expr<T>(node: ExpressionNode): Expression<T> {
  return { node } as Expression<T>
}

/** Unwrap an Expression to its underlying AST node */
export function unwrap<T>(e: Expression<T>): ExpressionNode {
  return e.node
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
