import { denseRank, filter, lag, lead, ntile, over, rank, rowNumber } from "../builder/eb.ts"

/**
 * Window function namespace.
 *
 * ```ts
 * import { win, over } from "sumak"
 *
 * over(win.rowNumber(), (w) => w.partitionBy("dept").orderBy("salary", "DESC"))
 * over(win.rank(), (w) => w.orderBy("score", "DESC"))
 * over(win.lag(col.price, 1), (w) => w.orderBy("date"))
 * ```
 */
export const win = {
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  ntile,
  over,
  filter,
} as const
