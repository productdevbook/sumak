import type { ColumnBuilder } from "./column.ts"
import type { ColumnType } from "./types.ts"

export interface TableDefinition<
  TName extends string = string,
  TColumns extends Record<string, ColumnBuilder<any, any, any>> = Record<
    string,
    ColumnBuilder<any, any, any>
  >,
> {
  readonly name: TName
  readonly columns: TColumns
}

/**
 * Define a table schema with typed columns.
 *
 * ```ts
 * const users = defineTable("users", {
 *   id: serial().primaryKey(),
 *   name: text().notNull(),
 *   email: text().notNull(),
 *   active: boolean().defaultTo(true),
 * });
 * ```
 */
export function defineTable<
  TName extends string,
  TColumns extends Record<string, ColumnBuilder<any, any, any>>,
>(name: TName, columns: TColumns): TableDefinition<TName, TColumns> {
  return Object.freeze({ name, columns })
}

/**
 * Extract the column type map from a table definition.
 * Used to build the DB type.
 *
 * ```ts
 * type DB = {
 *   users: InferTable<typeof usersTable>;
 *   posts: InferTable<typeof postsTable>;
 * };
 * ```
 */
export type InferTable<T extends TableDefinition> =
  T extends TableDefinition<any, infer Cols>
    ? {
        [K in keyof Cols]: Cols[K] extends ColumnBuilder<infer S, infer I, infer U>
          ? ColumnType<S, I, U>
          : never
      }
    : never
