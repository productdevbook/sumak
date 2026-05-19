import type { ExpressionNode, SelectNode, TableRefNode } from "./nodes.ts"

// ── Column Definition ──

export type ForeignKeyAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT"

export interface ColumnDefinitionNode {
  type: "column_definition"
  name: string
  dataType: string
  notNull?: boolean
  defaultTo?: ExpressionNode
  primaryKey?: boolean
  unique?: boolean
  /**
   * PG 15+ `UNIQUE NULLS NOT DISTINCT` modifier on the column-level
   * UNIQUE constraint. Treats NULLs as equal for uniqueness — i.e. at
   * most one row may have NULL in this column. Default behavior (NULLS
   * DISTINCT) lets multiple rows share NULL. Only meaningful when
   * {@link unique} is true; printers throw
   * `UnsupportedDialectFeatureError` on MySQL/SQLite/MSSQL when set.
   */
  uniqueNullsNotDistinct?: boolean
  check?: ExpressionNode
  autoIncrement?: boolean
  references?: {
    table: string
    column: string
    onDelete?: ForeignKeyAction
    onUpdate?: ForeignKeyAction
  }
  generatedAs?: {
    expression: ExpressionNode
    stored?: boolean
  }
  /**
   * Optional human-readable comment attached to the column. PG and MySQL
   * both support comments on columns. On MySQL the comment is emitted
   * **inline** in `CREATE TABLE` (`<col_def> COMMENT 'text'`); on PG the
   * `CREATE TABLE` syntax has no inline form and the DDL printer leaves
   * this field out of `CREATE TABLE` — the diff engine emits a separate
   * {@link CommentNode} instead. SQLite has no equivalent at all (its
   * SQL grammar accepts the keyword but only as a no-op comment in the
   * DDL text); MSSQL uses `sp_addextendedproperty`, a separate surface
   * we don't bridge. See {@link FEATURES.OBJECT_COMMENTS}.
   */
  comment?: string
}

// ── Table Constraints ──

export interface PrimaryKeyConstraintNode {
  type: "pk_constraint"
  name?: string
  columns: string[]
}

export interface UniqueConstraintNode {
  type: "unique_constraint"
  name?: string
  columns: string[]
  /**
   * PG 15+ `UNIQUE NULLS NOT DISTINCT` modifier. Treats NULLs as equal
   * for uniqueness — at most one row may have a NULL in any of the
   * constraint's columns. Default behavior (NULLS DISTINCT) lets
   * multiple rows share NULL. Printers throw
   * `UnsupportedDialectFeatureError` on MySQL/SQLite/MSSQL when set.
   */
  nullsNotDistinct?: boolean
}

export interface CheckConstraintNode {
  type: "check_constraint"
  name?: string
  expression: ExpressionNode
}

export interface ForeignKeyConstraintNode {
  type: "fk_constraint"
  name?: string
  columns: string[]
  references: {
    table: string
    columns: string[]
    onDelete?: ForeignKeyAction
    onUpdate?: ForeignKeyAction
  }
}

/**
 * Single element of a PG `EXCLUDE` constraint — a column reference (or
 * arbitrary expression) paired with the operator that must NOT hold
 * between the row's value and any other row's value. The classic
 * range-overlap case uses `column WITH &&`; the equality use case (a
 * UNIQUE that names its index method explicitly) uses `column WITH =`.
 *
 * `expr` is an arbitrary {@link ExpressionNode}; the schema-DSL layer
 * always materializes a `column_ref` node for the simple "named column"
 * case, but plain expressions (function calls, casts) flow through too.
 */
export interface ExcludeElement {
  expr: ExpressionNode
  operator: string
}

/**
 * PG-only table-level constraint. Generalizes UNIQUE — instead of
 * equality, each element pairs a column (or expression) with a
 * commutative operator. The classic case is range-overlap exclusion
 * for booking systems: `EXCLUDE USING gist (room WITH =, during WITH
 * &&)`. The constraint is backed by an index whose access method is
 * controlled by `method` (defaults to `gist`).
 *
 * The optional `where` predicate makes this a **partial exclude**:
 * the constraint only applies to rows where the predicate is true,
 * mirroring `CREATE INDEX … WHERE` semantics.
 *
 * Refused on MySQL / SQLite / MSSQL via `EXCLUDE_CONSTRAINTS` —
 * none have an equivalent table-constraint grammar. See
 * {@link FEATURES.EXCLUDE_CONSTRAINTS}.
 */
export interface ExcludeConstraintNode {
  type: "exclude_constraint"
  name?: string
  /** Index access method. Defaults to `gist` at print time when unset. */
  method?: string
  elements: ExcludeElement[]
  /**
   * Optional partial-exclude predicate. Same grammar as a partial-index
   * `WHERE` clause — limits the constraint to rows matching the
   * predicate. Useful for "at most one active row per priority" via
   * `EXCLUDE (priority WITH =) WHERE (active = true)`.
   */
  where?: ExpressionNode
}

export type TableConstraintNode =
  | PrimaryKeyConstraintNode
  | UniqueConstraintNode
  | CheckConstraintNode
  | ForeignKeyConstraintNode
  | ExcludeConstraintNode

// ── CREATE TABLE ──

export interface CreateTableNode {
  type: "create_table"
  table: TableRefNode
  columns: ColumnDefinitionNode[]
  constraints: TableConstraintNode[]
  ifNotExists?: boolean
  temporary?: boolean
  asSelect?: SelectNode
}

// ── ALTER TABLE ──

export type AlterTableAction =
  | { kind: "add_column"; column: ColumnDefinitionNode }
  | { kind: "drop_column"; column: string }
  | { kind: "rename_column"; from: string; to: string }
  | { kind: "rename_table"; to: string }
  | { kind: "alter_column"; column: string; set: AlterColumnSet }
  | { kind: "add_constraint"; constraint: TableConstraintNode }
  | { kind: "drop_constraint"; name: string }

export type AlterColumnSet =
  | { type: "set_not_null" }
  | { type: "drop_not_null" }
  | { type: "set_default"; value: ExpressionNode }
  | { type: "drop_default" }
  | {
      type: "set_data_type"
      dataType: string
      /**
       * Optional `USING <expression>` clause for the type change.
       * PG requires this when the old → new type isn't an implicit
       * cast (e.g. `text` → `int` needs `USING col::int`). MSSQL
       * and MySQL accept a best-effort convert without the clause
       * but may fail on bad data; we emit the clause on PG and
       * silently drop it elsewhere (since the syntax is PG-only).
       */
      using?: ExpressionNode
    }

export interface AlterTableNode {
  type: "alter_table"
  table: TableRefNode
  actions: AlterTableAction[]
}

// ── DROP TABLE ──

export interface DropTableNode {
  type: "drop_table"
  table: TableRefNode
  ifExists?: boolean
  cascade?: boolean
}

// ── CREATE INDEX ──

export interface CreateIndexNode {
  type: "create_index"
  name: string
  table: string
  columns: { column: string; direction?: "ASC" | "DESC" }[]
  expressions?: ExpressionNode[]
  unique?: boolean
  ifNotExists?: boolean
  using?: string
  /**
   * Partial index predicate — emitted as `WHERE <expr>` at the tail of
   * `CREATE [UNIQUE] INDEX`. Only rows for which the predicate evaluates
   * to TRUE are indexed, so the index is smaller and the planner can
   * pick it for queries that include the same predicate. Heavily used
   * for soft-delete (`WHERE deleted_at IS NULL`) and status filters
   * (`WHERE status = 'active'`).
   *
   * PG and SQLite (3.8+) both support this with identical syntax.
   * MySQL has no partial-index grammar at all; MSSQL has "filtered
   * indexes" with a similar `WHERE` clause but a stricter subset of
   * supported predicates — sumak refuses both with
   * `UnsupportedDialectFeatureError` rather than emitting SQL the
   * engine will reject. See {@link FEATURES.PARTIAL_INDEX}.
   */
  where?: ExpressionNode
}

// ── DROP INDEX ──

export interface DropIndexNode {
  type: "drop_index"
  name: string
  table?: string
  ifExists?: boolean
  cascade?: boolean
}

// ── CREATE VIEW ──

export interface CreateViewNode {
  type: "create_view"
  name: string
  schema?: string
  columns?: string[]
  /** Required at print time. Builder returns a node without it set; `.asSelect(...)` populates it. */
  asSelect?: SelectNode
  /**
   * `CREATE OR REPLACE VIEW` — PG / MySQL. Mutually exclusive with
   * {@link ifNotExists}. MSSQL has no `OR REPLACE` keyword (use
   * {@link orAlter} for the closest equivalent); SQLite has neither
   * form. The printer refuses on those dialects.
   */
  orReplace?: boolean
  /**
   * MSSQL-only `CREATE OR ALTER VIEW` (2016 SP1+). Replaces the view
   * if it exists, creates it otherwise — semantically equivalent to
   * `OR REPLACE` on PG / MySQL, but spelled differently. The printer
   * refuses on PG / MySQL / SQLite (each has its own form: PG/MySQL
   * use `OR REPLACE`; SQLite needs DROP+CREATE). Mutually exclusive
   * with {@link ifNotExists}.
   */
  orAlter?: boolean
  temporary?: boolean
  /**
   * PG only — emit `MATERIALIZED VIEW`. Materialized views cache the
   * query result on disk and must be refreshed explicitly (via
   * {@link RefreshMaterializedViewNode}). The printer refuses on MySQL /
   * SQLite / MSSQL, which have no MATERIALIZED VIEW grammar.
   */
  materialized?: boolean
  ifNotExists?: boolean
  /**
   * PG MATERIALIZED VIEW only — controls whether the view is populated
   * at creation (`WITH DATA`, the default) or left empty (`WITH NO
   * DATA`, which requires a subsequent REFRESH MATERIALIZED VIEW before
   * the view can be queried). Ignored on non-materialized views and
   * non-PG dialects.
   */
  withData?: boolean
}

// ── DROP VIEW ──

export interface DropViewNode {
  type: "drop_view"
  name: string
  ifExists?: boolean
  cascade?: boolean
  materialized?: boolean
}

// ── REFRESH MATERIALIZED VIEW ──

/**
 * PG-only `REFRESH MATERIALIZED VIEW [CONCURRENTLY] <name> [WITH NO DATA]`.
 * Rebuilds the cached result of a MATERIALIZED VIEW. The `CONCURRENTLY`
 * flag requires a UNIQUE index on the view and uses a swap-on-finish
 * strategy so reads see the old data until the new data is ready;
 * without it, reads block for the full duration of the refresh.
 * `WITH NO DATA` empties the view's storage (useful when paired with a
 * later non-concurrent refresh on a low-traffic window).
 *
 * MySQL / SQLite / MSSQL have no materialized views at all — the
 * printer refuses with `UnsupportedDialectFeatureError`.
 */
export interface RefreshMaterializedViewNode {
  type: "refresh_materialized_view"
  name: string
  schema?: string
  concurrently?: boolean
  withData?: boolean
}

// ── TRUNCATE TABLE ──

export interface TruncateTableNode {
  type: "truncate_table"
  table: TableRefNode
  cascade?: boolean
  restartIdentity?: boolean
}

// ── CREATE SCHEMA ──

export interface CreateSchemaNode {
  type: "create_schema"
  name: string
  ifNotExists?: boolean
  authorization?: string
}

// ── DROP SCHEMA ──

export interface DropSchemaNode {
  type: "drop_schema"
  name: string
  ifExists?: boolean
  cascade?: boolean
}

// ── COMMENT ON TABLE / COLUMN ──

/**
 * Standalone object-comment statement — PG's `COMMENT ON TABLE` /
 * `COMMENT ON COLUMN`, also lowered to MySQL's `ALTER TABLE … COMMENT
 * = 'text'` for table comments at print time. Used by the migration
 * diff engine when a comment is added, changed, or cleared on an
 * already-existing schema object; new tables fold the comment back
 * into the per-column field on MySQL and emit a follow-up CommentNode
 * on PG.
 *
 * - `target: "table"` → comment refers to `tableName`; `columnName`
 *   must be undefined.
 * - `target: "column"` → comment refers to `tableName.columnName`;
 *   `columnName` is required.
 * - `comment: null` → drop the comment (PG emits `IS NULL`; MySQL
 *   emits `COMMENT = ''` for the table form).
 *
 * SQLite has no equivalent and the DDL printer refuses. MSSQL uses
 * `sp_addextendedproperty` — also refused for the first cut.
 */
export interface CommentNode {
  type: "comment_on"
  target: "table" | "column"
  tableName: string
  columnName?: string
  comment: string | null
}

// ── Union of all DDL nodes ──

export type DDLNode =
  | CreateTableNode
  | AlterTableNode
  | DropTableNode
  | CreateIndexNode
  | DropIndexNode
  | CreateViewNode
  | DropViewNode
  | RefreshMaterializedViewNode
  | TruncateTableNode
  | CreateSchemaNode
  | DropSchemaNode
  | CommentNode
