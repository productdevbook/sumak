import {
  abs,
  ceil,
  cos,
  degrees,
  exp,
  floor,
  greatest,
  least,
  ln,
  log,
  pi,
  power,
  radians,
  round,
  sign,
  sin,
  sqrt,
  tan,
} from "../builder/eb.ts"

/**
 * Numeric/math function namespace.
 *
 * ```ts
 * import { num } from "sumak"
 *
 * num.abs(col.balance)
 * num.round(col.price, 2)
 * num.ceil(col.amount)
 * num.floor(col.amount)
 * num.greatest(col.a, col.b)
 * num.least(col.a, col.b)
 *
 * // Power / roots / logs
 * num.power(col.x, val(2))
 * num.sqrt(col.area)
 * num.ln(col.intensity)
 * num.log(col.ratio)            // base-10 on every dialect (sumak normalises)
 * num.exp(col.x)
 * num.sign(col.delta)
 *
 * // Trigonometry — arguments are in radians
 * num.pi()                      // PG / MySQL / MSSQL only
 * num.sin(num.radians(col.deg))
 * num.cos(col.theta)
 * num.tan(col.theta)
 * num.degrees(col.rad)
 * ```
 *
 * See {@link power}, {@link ln}, {@link log}, {@link pi} for the
 * dialect divergences (MSSQL has no `LN`, MySQL/MSSQL `LOG` is
 * natural log not base-10, SQLite has no `PI`). The builders
 * normalise the surface so the JS-level name maps to consistent
 * semantics across every dialect.
 */
export const num: {
  readonly abs: typeof abs
  readonly round: typeof round
  readonly ceil: typeof ceil
  readonly floor: typeof floor
  readonly greatest: typeof greatest
  readonly least: typeof least
  readonly power: typeof power
  readonly sqrt: typeof sqrt
  readonly ln: typeof ln
  readonly log: typeof log
  readonly exp: typeof exp
  readonly sign: typeof sign
  readonly pi: typeof pi
  readonly degrees: typeof degrees
  readonly radians: typeof radians
  readonly sin: typeof sin
  readonly cos: typeof cos
  readonly tan: typeof tan
} = {
  abs,
  round,
  ceil,
  floor,
  greatest,
  least,
  power,
  sqrt,
  ln,
  log,
  exp,
  sign,
  pi,
  degrees,
  radians,
  sin,
  cos,
  tan,
}
