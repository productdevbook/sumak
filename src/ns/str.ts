import { concat, length, lower, substring, trim, upper } from "../builder/eb.ts"

/**
 * String function namespace.
 *
 * ```ts
 * import { str } from "sumak"
 *
 * str.upper(col.name)
 * str.lower(col.email)
 * str.concat(col.first, val(" "), col.last)
 * str.substring(col.name, 1, 3)
 * str.trim(col.name)
 * str.length(col.name)
 * ```
 */
export const str: {
  readonly upper: typeof upper
  readonly lower: typeof lower
  readonly concat: typeof concat
  readonly substring: typeof substring
  readonly trim: typeof trim
  readonly length: typeof length
} = {
  upper,
  lower,
  concat,
  substring,
  trim,
  length,
}
