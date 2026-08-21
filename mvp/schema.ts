export interface Column<T> {
  readonly sqlType: string
  readonly __type?: T
}

export const int = (): Column<number> => ({ sqlType: "integer" })
export const text = (): Column<string> => ({ sqlType: "text" })
export const bool = (): Column<boolean> => ({ sqlType: "boolean" })
export const ts = (): Column<Date> => ({ sqlType: "timestamp" })

export type Table = Record<string, Column<unknown>>
export type Schema = Record<string, Table>

export type RowOf<T extends Table> = {
  [K in keyof T]: T[K] extends Column<infer V> ? V : never
}
