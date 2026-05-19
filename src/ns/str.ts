import {
  concat,
  length,
  lower,
  regexpLike,
  regexpMatches,
  regexpReplace,
  regexpSubstr,
  substring,
  trim,
  upper,
} from "../builder/eb.ts"

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
 * str.regexpReplace(col.phone, "[^0-9]", "")
 * str.regexpLike(col.email, "^[^@]+@[^@]+$")
 * str.regexpMatches(col.body, "https?://[^\\s]+", "g") // PG-only
 * str.regexpSubstr(col.body, "\\d+")
 * ```
 */
export const str: {
  readonly upper: typeof upper
  readonly lower: typeof lower
  readonly concat: typeof concat
  readonly substring: typeof substring
  readonly trim: typeof trim
  readonly length: typeof length
  readonly regexpReplace: typeof regexpReplace
  readonly regexpLike: typeof regexpLike
  readonly regexpMatches: typeof regexpMatches
  readonly regexpSubstr: typeof regexpSubstr
} = {
  upper,
  lower,
  concat,
  substring,
  trim,
  length,
  regexpReplace,
  regexpLike,
  regexpMatches,
  regexpSubstr,
}
