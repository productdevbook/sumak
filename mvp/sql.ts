import type { Prepared } from "./compile.ts"
import type { Args, Kind } from "./expr.ts"
import type { Column, Schema } from "./schema.ts"

type Ws = " " | "\n" | "\t" | "\r"

type Trim<S extends string> = S extends `${Ws}${infer R}`
  ? Trim<R>
  : S extends `${infer R}${Ws}`
    ? Trim<R>
    : S

type SplitList<S extends string> = S extends `${infer H},${infer R}`
  ? [Trim<H>, ...SplitList<R>]
  : [Trim<S>]

type OutputName<S extends string> = S extends `${string} AS ${infer A}`
  ? Trim<A>
  : S extends `${string} as ${infer A}`
    ? Trim<A>
    : S extends `${string}.${infer C}`
      ? Trim<C>
      : Trim<S>

type SourceName<S extends string> = S extends `${infer C} AS ${string}`
  ? SourceName<Trim<C>>
  : S extends `${infer C} as ${string}`
    ? SourceName<Trim<C>>
    : S extends `${string}.${infer C}`
      ? Trim<C>
      : Trim<S>

type FirstWord<S extends string> = S extends `${infer H}${Ws}${string}` ? Trim<H> : Trim<S>

type TableOf<S extends string> = S extends `${string}FROM ${infer R}`
  ? FirstWord<Trim<R>>
  : S extends `${string}from ${infer R}`
    ? FirstWord<Trim<R>>
    : never

type ColumnsOf<S extends string> = S extends `SELECT ${infer C} FROM ${string}`
  ? Trim<C>
  : S extends `select ${infer C} from ${string}`
    ? Trim<C>
    : never

type ValueOf<T> = T extends Column<infer V> ? V : never

export type RowOf<S extends Schema, Q extends string> =
  TableOf<Q> extends keyof S
    ? ColumnsOf<Q> extends "*"
      ? { [K in keyof S[TableOf<Q>]]: ValueOf<S[TableOf<Q>][K]> }
      : {
          [
            K in SplitList<ColumnsOf<Q>>[number] as OutputName<K>
          ]: SourceName<K> extends keyof S[TableOf<Q>]
            ? ValueOf<S[TableOf<Q>][SourceName<K>]>
            : unknown
        }
    : Record<string, unknown>

const PLACEHOLDER = /\$(\d+)/g

export function make<S extends Schema>(_schema: S) {
  return function query<const Q extends string, const K extends readonly Kind<unknown>[]>(
    sql: Q,
    ...kinds: K
  ): Prepared<Args<K>, RowOf<S, Q>> {
    const used = new Set<number>()
    for (const match of sql.matchAll(PLACEHOLDER)) used.add(Number(match[1]))

    for (const slot of used) {
      if (slot < 1 || slot > kinds.length) {
        throw new Error(`the query uses $${slot} but ${kinds.length} parameters were declared`)
      }
    }
    for (let slot = 1; slot <= kinds.length; slot++) {
      if (!used.has(slot)) {
        throw new Error(`parameter $${slot} was declared but never used in the query`)
      }
    }

    return { sql, arity: kinds.length, direct: true, bind: (args) => args }
  }
}
