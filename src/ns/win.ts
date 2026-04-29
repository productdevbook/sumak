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
export const win: {
  readonly rowNumber: typeof rowNumber
  readonly rank: typeof rank
  readonly denseRank: typeof denseRank
  readonly lag: typeof lag
  readonly lead: typeof lead
  readonly ntile: typeof ntile
  readonly over: typeof over
  readonly filter: typeof filter
} = {
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  ntile,
  over,
  filter,
}
