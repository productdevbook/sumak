import {
  all,
  any,
  arrayAppend,
  arrayCat,
  arrayContainedBy,
  arrayContains,
  arrayLength,
  arrayLiteral,
  arrayOverlaps,
  arrayPosition,
  arrayPositions,
  arrayPrepend,
  arrayRemove,
  arrayReplace,
  arrayToString,
  some,
  unnest,
} from "../builder/eb.ts"

/**
 * PostgreSQL array operator namespace + quantified comparison
 * helpers, plus the function-call builders (`array_append`,
 * `array_cat`, `unnest`, …). Every member here is PG-only — the
 * non-PG printers throw `UnsupportedDialectFeatureError` at compile
 * time.
 *
 * ```ts
 * import { arr, col, val } from "sumak"
 *
 * arr.contains(col.tags, arr.literal([val("sql")]))    // @>
 * arr.overlaps(col.tags, arr.literal([val("sql")]))    // &&
 * col.id.eq(arr.any(arr.literal([val(1), val(2)])))    // = ANY(...)
 *
 * arr.append(col.tags, val("new"))                     // ARRAY_APPEND
 * arr.length(col.tags)                                 // ARRAY_LENGTH(...,1)
 * arr.toString(col.tags, val(","))                     // ARRAY_TO_STRING
 * arr.unnest(col.tags)                                 // UNNEST
 * ```
 */
export const arr: {
  readonly contains: typeof arrayContains
  readonly containedBy: typeof arrayContainedBy
  readonly overlaps: typeof arrayOverlaps
  readonly literal: typeof arrayLiteral
  readonly any: typeof any
  readonly all: typeof all
  readonly some: typeof some
  readonly append: typeof arrayAppend
  readonly prepend: typeof arrayPrepend
  readonly cat: typeof arrayCat
  readonly length: typeof arrayLength
  readonly positions: typeof arrayPositions
  readonly position: typeof arrayPosition
  readonly remove: typeof arrayRemove
  readonly replace: typeof arrayReplace
  readonly toString: typeof arrayToString
  readonly unnest: typeof unnest
} = {
  contains: arrayContains,
  containedBy: arrayContainedBy,
  overlaps: arrayOverlaps,
  literal: arrayLiteral,
  any,
  all,
  some,
  append: arrayAppend,
  prepend: arrayPrepend,
  cat: arrayCat,
  length: arrayLength,
  positions: arrayPositions,
  position: arrayPosition,
  remove: arrayRemove,
  replace: arrayReplace,
  toString: arrayToString,
  unnest,
}
