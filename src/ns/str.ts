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
export const str = {
  upper,
  lower,
  concat,
  substring,
  trim,
  length,
} as const
