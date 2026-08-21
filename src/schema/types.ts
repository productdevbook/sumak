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
 * Extract the SELECT type from a column.
 * Works with both ColumnType and ColumnBuilder (both declare __select).
 */
export type SelectType<C> = C extends { readonly __select: infer S } ? S : C

/** Extract the INSERT type from a column. */
export type InsertType<C> = C extends { readonly __insert: infer I } ? I : C

/** Extract the UPDATE type from a column. */
export type UpdateType<C> = C extends { readonly __update: infer U } ? U : C

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
 * Every `table.column` name that is legal while `TB` is in scope.
 *
 * The builder accepts these wherever a bare column name goes, so a join can
 * name the side it means. `parseColumnRef` splits the string at compile time;
 * this is the half that keeps a typo out.
 */
export type QualifiedColumn<DB, TB extends keyof DB> = {
  [T in TB & string]: `${T}.${keyof DB[T] & string}`
}[TB & string]

/** The key a qualified name contributes to the output row. */
export type UnqualifiedName<K extends string> = K extends `${string}.${infer C}` ? C : K

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
  [K in keyof T as IsRequired<T[K]> extends true ? K : never]: Writable<InsertType<T[K]>>
} & {
  [K in keyof T as IsRequired<T[K]> extends true ? never : K]?: Writable<InsertType<T[K]>>
}

/**
 * A value a write accepts: the column's own type, or an expression standing in
 * for it.
 *
 * The expression form is how a value with nothing to bind reaches a write —
 * `NEW.name` inside a trigger function, a declared plpgsql variable — where a
 * parameter placeholder would name the wrong thing.
 */
export type Writable<T> = T | import("../ast/typed-expression.ts").Expression<T>

/**
 * Infer an UPDATE row type. All columns optional.
 */
export type Updateable<T> = {
  [K in keyof T]?: Writable<UpdateType<T[K]>>
}

// ── Drizzle-style aliases ────────────────────────────────────────────
//
// Pure aliases for the three column-map row helpers above. The names
// match drizzle's `InferSelectModel` / `InferInsertModel` /
// `InferUpdateModel` so users coming from drizzle find the type they
// expect; the underlying mechanics are identical to `Selectable` /
// `Insertable` / `Updateable`. Aliases not re-implementations — there's
// only one type per row shape.

/**
 * Infer a SELECT row type from a column map. Drizzle-compatible name.
 *
 * ```ts
 * const tables = { users: { id: serial(), name: text().notNull() } }
 * type User = InferSelectModel<typeof tables.users>
 * // = { id: number, name: string }
 * ```
 */
export type InferSelectModel<T> = Selectable<T>

/**
 * Infer an INSERT row type from a column map. Drizzle-compatible name.
 * Generated / default / nullable columns become optional.
 *
 * ```ts
 * type NewUser = InferInsertModel<typeof tables.users>
 * // = { id?: number, name: string }
 * ```
 */
export type InferInsertModel<T> = Insertable<T>

/**
 * Infer an UPDATE row type from a column map. Drizzle-compatible name.
 * Every column becomes optional.
 *
 * ```ts
 * type UserUpdate = InferUpdateModel<typeof tables.users>
 * // = { id?: number, name?: string }
 * ```
 */
export type InferUpdateModel<T> = Updateable<T>

/**
 * A column is required on INSERT if its InsertType does NOT include undefined or never.
 */
type IsRequired<C> =
  InsertType<C> extends never ? false : undefined extends InsertType<C> ? false : true
