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

export type TableConstraintNode =
  | PrimaryKeyConstraintNode
  | UniqueConstraintNode
  | CheckConstraintNode
  | ForeignKeyConstraintNode

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
  orReplace?: boolean
  temporary?: boolean
  materialized?: boolean
  ifNotExists?: boolean
}

// ── DROP VIEW ──

export interface DropViewNode {
  type: "drop_view"
  name: string
  ifExists?: boolean
  cascade?: boolean
  materialized?: boolean
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
  | TruncateTableNode
  | CreateSchemaNode
  | DropSchemaNode
  | CommentNode
