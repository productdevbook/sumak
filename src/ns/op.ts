import { add, div, mod, mul, neg, sub } from "../builder/eb.ts"

/**
 * Arithmetic operator namespace. These wrap the SQL binary operators
 * `+ - * / %` and unary `-` — useful when you want a `.gt()` / `.eq()`
 * on a computed expression without dropping to raw SQL.
 *
 * ```ts
 * import { op } from "sumak"
 *
 * // price * (1 + tax_rate)
 * op.mul(col.price, op.add(val(1), col.tax_rate))
 *
 * // -balance
 * op.neg(col.balance)
 * ```
 */
export const op: {
  readonly add: typeof add
  readonly sub: typeof sub
  readonly mul: typeof mul
  readonly div: typeof div
  readonly mod: typeof mod
  readonly neg: typeof neg
} = {
  add,
  sub,
  mul,
  div,
  mod,
  neg,
}
