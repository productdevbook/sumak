/**
 * Three-phase column type: Select, Insert, Update.
 *
 * S = type returned on SELECT
 * I = type accepted on INSERT
 * U = type accepted on UPDATE
 */
export interface ColumnType<S, I = S, U = I> {
  readonly __select: S
  readonly __insert: I
  readonly __update: U
}

/** DB generates this value (autoincrement, default). Optional on INSERT/UPDATE. */
export type Generated<T> = ColumnType<T, T | undefined, T | undefined>

/** DB always generates (identity always). Never provided by user. */
export type GeneratedAlways<T> = ColumnType<T, never, never>

/**
 * Any type that carries __select/__insert/__update branded fields.
 * Both ColumnType and ColumnBuilder satisfy this.
 */
type HasPhases = { readonly __select: any; readonly __insert: any; readonly __update: any }

/**
 * Extract the SELECT type from a column.
 * Uses indexed access (O(1) symbol lookup in tsgo) instead of conditional type.
 */
export type SelectType<C> = C extends HasPhases ? C["__select"] : C

/** Extract the INSERT type from a column. */
export type InsertType<C> = C extends HasPhases ? C["__insert"] : C

/** Extract the UPDATE type from a column. */
export type UpdateType<C> = C extends HasPhases ? C["__update"] : C

/** Make all properties nullable. */
export type Nullable<T> = { [K in keyof T]: T[K] | null }

/**
 * Select row type for a table. Cached alias — tsgo instantiation cache
 * deduplicates across selectFrom, join, returning.
 */
export type SelectRow<DB, TB extends keyof DB> = {
  [K in keyof DB[TB]]: SelectType<DB[TB][K]>
}

/**
 * Infer a SELECT row type from a column map.
 */
export type Selectable<T> = {
  [K in keyof T]: SelectType<T[K]>
}

/**
 * Infer an INSERT row type from a column map.
 * Required columns: non-nullable without default.
 * Optional columns: nullable, has default, or generated.
 */
export type Insertable<T> = {
  [K in keyof T as IsRequired<T[K]> extends true ? K : never]: InsertType<T[K]>
} & {
  [K in keyof T as IsRequired<T[K]> extends true ? never : K]?: InsertType<T[K]>
}

/**
 * Infer an UPDATE row type. All columns optional.
 */
export type Updateable<T> = {
  [K in keyof T]?: UpdateType<T[K]>
}

/**
 * A column is required on INSERT if its InsertType does NOT include undefined or never.
 */
type IsRequired<C> =
  InsertType<C> extends never ? false : undefined extends InsertType<C> ? false : true
