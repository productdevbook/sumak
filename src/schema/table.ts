import type { ForeignKeyAction } from "../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import type { ColumnBuilder } from "./column.ts"
import type { ColumnType } from "./types.ts"

// ── Table-level constraint DSL ────────────────────────────────────────

/**
 * Composite primary key. Either a bare list of columns (auto-named by
 * the DB engine) or an object with an explicit name for predictable
 * migrations across deployments.
 */
export type PrimaryKeyDef = readonly string[] | { name?: string; columns: readonly string[] }

/**
 * Composite unique constraint — same shape as {@link PrimaryKeyDef}.
 */
export type UniqueDef = readonly string[] | { name?: string; columns: readonly string[] }

/**
 * Table-level CHECK constraint. The expression is either a raw SQL
 * fragment (schema-author controlled — never user input) or a sumak
 * {@link Expression} whose AST node is preserved so the printer applies
 * dialect-correct quoting and parameter binding.
 */
export interface CheckDef {
  readonly name?: string
  readonly expression: Expression<boolean> | string
}

/**
 * Named / composite foreign key declared at the table level. The
 * column-level `.references()` short form is unchanged; this is for the
 * cases it can't express (named constraint, multi-column FK).
 */
export interface ForeignKeyDef {
  readonly name?: string
  readonly columns: readonly string[]
  readonly references: { readonly table: string; readonly columns: readonly string[] }
  readonly onDelete?: ForeignKeyAction
  readonly onUpdate?: ForeignKeyAction
}

export interface TableConstraints {
  readonly primaryKey?: PrimaryKeyDef
  readonly uniques?: readonly UniqueDef[]
  readonly checks?: readonly CheckDef[]
  readonly foreignKeys?: readonly ForeignKeyDef[]
}

/**
 * Options accepted as the third argument of {@link defineTable}. Kept
 * open so follow-ups (indexes, triggers, …) can land additively.
 */
export interface TableOptions {
  readonly constraints?: TableConstraints
}

export interface TableDefinition<
  TName extends string = string,
  TColumns extends Record<string, ColumnBuilder<any, any, any>> = Record<
    string,
    ColumnBuilder<any, any, any>
  >,
> {
  readonly name: TName
  readonly columns: TColumns
  readonly constraints?: TableConstraints
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
 *
 * const orderItems = defineTable(
 *   "order_items",
 *   { orderId: integer().notNull(), sku: text().notNull(), qty: integer().notNull() },
 *   {
 *     constraints: {
 *       primaryKey: ["orderId", "sku"],
 *       checks: [{ name: "ck_qty_positive", expression: "qty > 0" }],
 *     },
 *   },
 * )
 * ```
 */
export function defineTable<
  TName extends string,
  TColumns extends Record<string, ColumnBuilder<any, any, any>>,
>(name: TName, columns: TColumns, options?: TableOptions): TableDefinition<TName, TColumns> {
  const def: TableDefinition<TName, TColumns> = options?.constraints
    ? { name, columns, constraints: options.constraints }
    : { name, columns }
  return Object.freeze(def)
}

// ── Runtime helpers ───────────────────────────────────────────────────

/**
 * Normalized table shape — what sumak's internals see after lowering
 * either raw `{ id: serial() }` columns maps or {@link TableDefinition}
 * wrappers into a single form. Not exported; the `sumak({ tables })`
 * public surface still accepts both.
 *
 * @internal
 */
export interface NormalizedTable {
  readonly columns: Record<string, ColumnBuilder<any, any, any>>
  readonly constraints?: TableConstraints
}

const TABLE_DEF_MARKERS = ["name", "columns"] as const

/**
 * Detect a {@link TableDefinition} vs a raw columns map. A raw columns
 * map has a `ColumnBuilder` at every top-level key; a TableDefinition
 * has `name: string` + `columns: Record<...>`. We check the marker
 * shape rather than instanceof because ColumnBuilder instances are
 * plain objects with a `_def` field.
 */
export function isTableDefinition(entry: unknown): entry is TableDefinition {
  if (entry === null || typeof entry !== "object") return false
  const obj = entry as Record<string, unknown>
  return TABLE_DEF_MARKERS.every((k) => k in obj) && typeof obj["name"] === "string"
}

/**
 * Lower a public table entry into the internal {@link NormalizedTable}
 * shape.
 *
 * @internal
 */
export function normalizeTableEntry(
  entry: Record<string, ColumnBuilder<any, any, any>> | TableDefinition,
): NormalizedTable {
  if (isTableDefinition(entry)) {
    return entry.constraints
      ? { columns: entry.columns, constraints: entry.constraints }
      : { columns: entry.columns }
  }
  return { columns: entry }
}

/**
 * Resolve a {@link CheckDef} to either a raw SQL string or a pre-built
 * AST node, matching the two shapes the column-level `.check(...)` API
 * accepts.
 *
 * @internal
 */
export function resolveCheckExpression(expr: Expression<boolean> | string): {
  sql: string
  node?: ExpressionNode
} {
  if (typeof expr === "string") return { sql: expr }
  const node = (expr as unknown as { node: ExpressionNode }).node
  return { sql: "", node }
}

/**
 * Normalize a {@link PrimaryKeyDef} / {@link UniqueDef} to a stable
 * `{ name?, columns }` record for diff comparison + DDL emission.
 *
 * @internal
 */
export function normalizeKeyDef(def: PrimaryKeyDef | UniqueDef): {
  name?: string
  columns: string[]
} {
  if (Array.isArray(def)) return { columns: [...def] }
  const obj = def as { name?: string; columns: readonly string[] }
  return obj.name === undefined
    ? { columns: [...obj.columns] }
    : { name: obj.name, columns: [...obj.columns] }
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
