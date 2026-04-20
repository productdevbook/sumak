import { arrayContainedBy, arrayContains, arrayOverlaps } from "../builder/eb.ts"

/**
 * PostgreSQL array operator namespace.
 *
 * ```ts
 * import { arr, rawExpr } from "sumak"
 *
 * arr.contains(col.tags, rawExpr("ARRAY['sql']"))      // @>
 * arr.containedBy(col.tags, rawExpr("ARRAY[...]"))     // <@
 * arr.overlaps(col.tags, rawExpr("ARRAY['sql']"))      // &&
 * ```
 */
export const arr = {
  contains: arrayContains,
  containedBy: arrayContainedBy,
  overlaps: arrayOverlaps,
} as const
