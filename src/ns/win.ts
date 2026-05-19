import {
  denseRank,
  filter,
  firstValue,
  lag,
  lastValue,
  lead,
  nthValue,
  ntile,
  over,
  rank,
  rowNumber,
} from "../builder/eb.ts"

/**
 * Window function namespace.
 *
 * ```ts
 * import { win, over } from "sumak"
 *
 * over(win.rowNumber(), (w) => w.partitionBy("dept").orderBy("salary", "DESC"))
 * over(win.rank(), (w) => w.orderBy("score", "DESC"))
 * over(win.lag(col.price, 1), (w) => w.orderBy("date"))
 * over(win.firstValue(col.price), (w) => w.partitionBy("symbol").orderBy("ts"))
 * ```
 */
export const win: {
  readonly rowNumber: typeof rowNumber
  readonly rank: typeof rank
  readonly denseRank: typeof denseRank
  readonly lag: typeof lag
  readonly lead: typeof lead
  readonly ntile: typeof ntile
  readonly firstValue: typeof firstValue
  readonly lastValue: typeof lastValue
  readonly nthValue: typeof nthValue
  readonly over: typeof over
  readonly filter: typeof filter
} = {
  rowNumber,
  rank,
  denseRank,
  lag,
  lead,
  ntile,
  firstValue,
  lastValue,
  nthValue,
  over,
  filter,
}
