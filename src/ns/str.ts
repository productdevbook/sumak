import {
  concat,
  length,
  lower,
  ltrim,
  overlay,
  position,
  regexpLike,
  regexpMatches,
  regexpReplace,
  regexpSubstr,
  replace,
  reverse,
  rtrim,
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
 * str.ltrim(col.name)
 * str.rtrim(col.name)
 * str.length(col.name)
 * str.replace(col.body, val("foo"), val("bar"))
 * str.position(val("@"), col.email)
 * str.overlay(col.phone, val("***"), 4, 3)   // PG / MySQL 8 / MSSQL
 * str.reverse(col.name)
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
  readonly ltrim: typeof ltrim
  readonly rtrim: typeof rtrim
  readonly length: typeof length
  readonly replace: typeof replace
  readonly position: typeof position
  readonly overlay: typeof overlay
  readonly reverse: typeof reverse
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
  ltrim,
  rtrim,
  length,
  replace,
  position,
  overlay,
  reverse,
  regexpReplace,
  regexpLike,
  regexpMatches,
  regexpSubstr,
}
