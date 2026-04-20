import { abs, ceil, floor, greatest, least, round } from "../builder/eb.ts"

/**
 * Numeric/math function namespace.
 *
 * ```ts
 * import { num } from "sumak"
 *
 * num.abs(col.balance)
 * num.round(col.price, 2)
 * num.ceil(col.amount)
 * num.floor(col.amount)
 * num.greatest(col.a, col.b)
 * num.least(col.a, col.b)
 * ```
 */
export const num = {
  abs,
  round,
  ceil,
  floor,
  greatest,
  least,
} as const
