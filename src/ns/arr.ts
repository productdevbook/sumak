import {
  all,
  any,
  arrayContainedBy,
  arrayContains,
  arrayLiteral,
  arrayOverlaps,
  some,
} from "../builder/eb.ts"

/**
 * PostgreSQL array operator namespace + quantified comparison
 * helpers.
 *
 * ```ts
 * import { arr, col, val } from "sumak"
 *
 * arr.contains(col.tags, arr.literal([val("sql")]))    // @>
 * arr.overlaps(col.tags, arr.literal([val("sql")]))    // &&
 * col.id.eq(arr.any(arr.literal([val(1), val(2)])))    // = ANY(...)
 * ```
 */
export const arr = {
  contains: arrayContains,
  containedBy: arrayContainedBy,
  overlaps: arrayOverlaps,
  literal: arrayLiteral,
  any,
  all,
  some,
} as const
