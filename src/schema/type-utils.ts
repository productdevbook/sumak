import type { ColumnType, SelectType } from "./types.ts"

/** Make all properties of T nullable */
export type Nullable<T> = { [K in keyof T]: T[K] | null }

/** Extract table names from DB type */
export type TableName<DB> = keyof DB & string

/** Extract column names for a table */
export type ColumnName<DB, TB extends keyof DB> = keyof DB[TB] & string

/** Qualified column reference: "table.column" */
export type QualifiedColumn<DB, TB extends keyof DB> = TB extends string
  ? `${TB}.${keyof DB[TB] & string}`
  : never

/** Any column reference (unqualified or qualified) in scope */
export type AnyColumn<DB, TB extends keyof DB> = ColumnName<DB, TB> | QualifiedColumn<DB, TB>

/**
 * Resolve a column reference string to its SelectType.
 * Handles both "column" and "table.column" formats.
 */
export type ResolveColumnType<
  DB,
  TB extends keyof DB,
  Ref extends string,
> = Ref extends `${infer T}.${infer C}`
  ? T extends TB & string
    ? C extends keyof DB[T]
      ? SelectType<DB[T][C]>
      : never
    : never
  : TB extends keyof DB
    ? Ref extends keyof DB[TB]
      ? SelectType<DB[TB][Ref]>
      : never
    : never

/**
 * Resolve result type when selecting specific columns.
 * Given DB, TB (tables in scope), and selected column strings,
 * build the output row type.
 */
export type SelectResult<DB, TB extends keyof DB, Cols extends AnyColumn<DB, TB>> = {
  [K in Cols as K extends `${string}.${infer C}` ? C : K]: ResolveColumnType<DB, TB, K>
}

/**
 * Full select model for a single table - all columns included.
 */
export type FullSelectModel<DB, TB extends keyof DB> = {
  [K in keyof DB[TB]]: DB[TB][K] extends ColumnType<infer S, any, any> ? S : DB[TB][K]
}
