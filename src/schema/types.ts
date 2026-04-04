/**
 * Three-phase column type: Select, Insert, Update.
 *
 * S = type returned on SELECT
 * I = type accepted on INSERT
 * U = type accepted on UPDATE
 */
export interface ColumnType<S, I = S, U = I> {
  readonly __select: S;
  readonly __insert: I;
  readonly __update: U;
}

/** DB generates this value (autoincrement, default). Optional on INSERT/UPDATE. */
export type Generated<T> = ColumnType<T, T | undefined, T | undefined>;

/** DB always generates (identity always). Never provided by user. */
export type GeneratedAlways<T> = ColumnType<T, never, never>;

/** Extract the SELECT type from a column. */
export type SelectType<C> = C extends ColumnType<infer S, any, any> ? S : C;

/** Extract the INSERT type from a column. */
export type InsertType<C> = C extends ColumnType<any, infer I, any> ? I : C;

/** Extract the UPDATE type from a column. */
export type UpdateType<C> = C extends ColumnType<any, any, infer U> ? U : C;

/** Make all properties nullable. */
export type Nullable<T> = { [K in keyof T]: T[K] | null };

/**
 * Infer a SELECT row type from a table column map.
 * Every column present, nullable columns include null.
 */
export type Selectable<T> = {
  [K in keyof T]: SelectType<T[K]>;
};

/**
 * Infer an INSERT row type from a table column map.
 * Required columns: non-nullable without default.
 * Optional columns: nullable, has default, or generated.
 */
export type Insertable<T> = {
  [K in keyof T as IsRequired<T[K]> extends true ? K : never]: InsertType<T[K]>;
} & {
  [K in keyof T as IsRequired<T[K]> extends true ? never : K]?: InsertType<T[K]>;
};

/**
 * Infer an UPDATE row type. All columns optional.
 */
export type Updateable<T> = {
  [K in keyof T]?: UpdateType<T[K]>;
};

/**
 * Select row type for a table. Cached alias — avoids repeated mapped type
 * instantiations across selectFrom, join, returning (tsgo alias cache optimization).
 */
export type SelectRow<DB, TB extends keyof DB> = {
  [K in keyof DB[TB]]: SelectType<DB[TB][K]>;
};

/**
 * A column is required on INSERT if its InsertType does NOT include undefined or never.
 */
type IsRequired<C> =
  InsertType<C> extends never ? false : undefined extends InsertType<C> ? false : true;
