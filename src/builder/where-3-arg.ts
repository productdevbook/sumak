import type { ExpressionNode } from "../ast/nodes.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Expression } from "../ast/typed-expression.ts"
import type { SelectType } from "../schema/types.ts"
import { Col, createColumnProxies } from "./eb.ts"

/**
 * Subset of SQL comparison / pattern / list / null operators that the
 * three-argument `where(col, op, val)` form accepts. Mirrors kysely's
 * `where(...)` operator string and is the loud, runtime-checked
 * version of the previous silent-no-op behaviour (which dropped the
 * operator and value entirely; see PR #95).
 *
 * Operator groups are split out as named types so the builder
 * overload signatures can pin the RHS type per group — `like` only
 * accepts a string, `in` only an array, `is` / `is not` only `null`.
 * That keeps user typos like `where("name", "like", 42)` as
 * compile-time errors rather than runtime throws.
 */
export type ComparisonScalarOp = "=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">="
export type ComparisonStringOp = "like" | "not like" | "ilike" | "not ilike"
export type ComparisonListOp = "in" | "not in"
export type ComparisonNullOp = "is" | "is not"

export type ComparisonOp =
  | ComparisonScalarOp
  | ComparisonStringOp
  | ComparisonListOp
  | ComparisonNullOp

/**
 * Map an operator string to the RHS type it requires. Lets a single
 * overload signature `where(col, op, val: WhereValueForOp<Op, ColType>)`
 * narrow `val` per operator: strings only for `like`-family, arrays
 * for `in`-family, `null` for `is` / `is not`, and the column's own
 * type for scalar comparisons.
 */
export type WhereValueForOp<Op extends ComparisonOp, ColType> = Op extends ComparisonNullOp
  ? null
  : Op extends ComparisonStringOp
    ? string
    : Op extends ComparisonListOp
      ? ReadonlyArray<SelectType<ColType>>
      : SelectType<ColType>

/**
 * Build the predicate ExpressionNode for `.where(col, op, val)` form.
 * Reuses the existing `Col` operators so the AST shape is identical to
 * the callback form — `.where("id", "=", 1)` produces the same node
 * tree as `.where(({ id }) => id.eq(1))`.
 *
 * @internal
 */
export function resolveWhere3Arg<DB, TB extends keyof DB>(
  table: TB & string,
  col: string,
  op: ComparisonOp,
  val: unknown,
): ExpressionNode {
  const cols = createColumnProxies<DB, TB>(table) as Record<string, Col<unknown>>
  const c = cols[col]
  if (!c) {
    // `createColumnProxies` returns a Proxy whose `get` trap always
    // returns a fresh `Col`, so this branch is unreachable today —
    // but the explicit guard documents the intent and avoids a
    // confusing downstream error if the proxy implementation ever
    // changes.
    throw new TypeError(`where(${JSON.stringify(col)}, …) — unknown column name`)
  }
  return unwrap(applyOp(c, op, val))
}

function applyOp(col: Col<unknown>, op: ComparisonOp, val: unknown): Expression<boolean> {
  // `Col<unknown>` is the proxy's static type. The methods carry
  // `this: Col<T>` constraints that v8/tsgo can't narrow from the
  // outside, so we punch through with `as any` once. Runtime args
  // are validated above in `assertString` / `assertArray` / the
  // null-RHS check, so no values reach a Col method untyped.
  const c = col as Col<any>
  switch (op) {
    case "=":
    case "==":
      return c.eq(val)
    case "!=":
    case "<>":
      return c.neq(val)
    case "<":
      return c.lt(val)
    case "<=":
      return c.lte(val)
    case ">":
      return c.gt(val)
    case ">=":
      return c.gte(val)
    case "like":
      assertString(val, op)
      return c.like(val)
    case "not like":
      assertString(val, op)
      return c.like(val, { negate: true })
    case "ilike":
      assertString(val, op)
      return c.like(val, { insensitive: true })
    case "not ilike":
      assertString(val, op)
      return c.like(val, { insensitive: true, negate: true })
    case "in":
      assertArray(val, op)
      return c.in(val as unknown[])
    case "not in":
      assertArray(val, op)
      return c.in(val as unknown[], { negate: true })
    case "is":
      if (val !== null) {
        throw new TypeError(
          `where(col, "is", val) — "is" requires a null RHS. Got ${typeof val}. ` +
            `For equality with non-null values use "=" instead.`,
        )
      }
      return c.isNull()
    case "is not":
      if (val !== null) {
        throw new TypeError(
          `where(col, "is not", val) — "is not" requires a null RHS. Got ${typeof val}. ` +
            `For inequality with non-null values use "!=" or "<>" instead.`,
        )
      }
      return c.isNull({ negate: true })
    default: {
      // exhaustive — TypeScript will error if a new ComparisonOp is added
      // and not handled here.
      const exhaustive: never = op
      throw new TypeError(`where(col, ${JSON.stringify(exhaustive)}, val) — unknown operator`)
    }
  }
}

function assertString(val: unknown, op: ComparisonOp): asserts val is string {
  if (typeof val !== "string") {
    throw new TypeError(
      `where(col, "${op}", val) — "${op}" requires a string RHS. Got ${typeof val}.`,
    )
  }
}

function assertArray(val: unknown, op: ComparisonOp): asserts val is readonly unknown[] {
  if (!Array.isArray(val)) {
    throw new TypeError(
      `where(col, "${op}", val) — "${op}" requires an array RHS. Got ${typeof val}.`,
    )
  }
}

/**
 * Discriminator: is the first argument to `.where()` a column name
 * string in the 3-arg form, or one of the other accepted shapes
 * (Expression / callback)? The previous `unwrapPredicate` guard
 * treated strings as "definitely a mistake"; now strings ARE valid
 * — but only when followed by an operator and value.
 *
 * Distinguishes `.where("id", "=", undefined)` (clear misuse — falls
 * through to the unwrapPredicate guard for a loud throw) from
 * `.where("deleted_at", "is", null)` (legit — `is` / `is not`
 * explicitly require null RHS). For all other operators, `val ===
 * undefined` is a sign the caller passed 2 args instead of 3.
 *
 * @internal
 */
export function isWhere3ArgCall(args: readonly unknown[]): boolean {
  if (args.length !== 3) return false
  if (typeof args[0] !== "string") return false
  if (typeof args[1] !== "string") return false
  const op = args[1]
  if (args[2] === undefined && op !== "is" && op !== "is not") return false
  return true
}
