import type { ASTNode, ExpressionNode, SelectNode, TableRefNode } from "./nodes.ts"

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
  /**
   * Toggle PostgreSQL Row Level Security on this table. PG only — the
   * DDL printer refuses on MySQL / SQLite / MSSQL via the
   * `ROW_LEVEL_SECURITY` feature gate.
   *
   *  - `enable` → `ENABLE ROW LEVEL SECURITY` — turns the policy
   *    machinery on. Without policies the default is "deny all" for
   *    non-owner roles.
   *  - `disable` → `DISABLE ROW LEVEL SECURITY` — RLS is off and the
   *    table behaves as a plain table again.
   *  - `force` → `FORCE ROW LEVEL SECURITY` — RLS also applies to the
   *    table owner (by default owners bypass RLS).
   *  - `no_force` → `NO FORCE ROW LEVEL SECURITY` — back to the
   *    default owner-bypass behaviour.
   */
  | { kind: "set_rls"; mode: "enable" | "disable" | "force" | "no_force" }

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

/**
 * `TRUNCATE [TABLE] [ONLY] <tab1>[, <tab2>...] [RESTART IDENTITY | CONTINUE
 * IDENTITY] [CASCADE | RESTRICT]`.
 *
 * PostgreSQL has the richest grammar — it accepts the full SQL standard
 * form: multiple tables in one statement, `ONLY` to skip table inheritance
 * children, `RESTART IDENTITY` to reset attached sequences, and
 * `CASCADE` / `RESTRICT` for foreign-key handling. MySQL and SQL Server
 * accept only the simple `TRUNCATE TABLE <name>` form — no multi-table,
 * no identity reset (use `ALTER TABLE … AUTO_INCREMENT` / `DBCC
 * CHECKIDENT` instead), no cascade. SQLite has no `TRUNCATE` at all; the
 * printer refuses with a pointer at `DELETE FROM <table>` as the
 * workaround.
 *
 * `cascade` and `restrict` are mutually exclusive — set only one. The
 * SQL default when neither is set is `RESTRICT`; the printer omits the
 * keyword in that case (the engine applies the default).
 *
 * `restartIdentity` and `continueIdentity` are mutually exclusive too;
 * `CONTINUE IDENTITY` is the SQL standard default and the printer omits
 * it for compactness when set. Setting `restartIdentity` true emits the
 * `RESTART IDENTITY` keyword.
 */
export interface TruncateTableNode {
  type: "truncate_table"
  /**
   * One or more tables to truncate. PostgreSQL accepts multiple in a
   * single statement (atomic — all-or-nothing); MySQL and MSSQL accept
   * exactly one. The printer refuses if `tables.length > 1` on a
   * non-PG dialect.
   */
  tables: TableRefNode[]
  /**
   * PG only — emit `ONLY` to skip inheritance descendants. Without it
   * PG truncates the named table *and* every table that inherits from
   * it; with it only the named relation is truncated. MySQL / MSSQL
   * have no table inheritance and the printer refuses if set there.
   */
  only?: boolean
  /**
   * PG only — emit `RESTART IDENTITY`. Restarts the sequences attached
   * to any of the truncated tables' identity columns. MySQL / MSSQL
   * have separate mechanisms (`ALTER TABLE … AUTO_INCREMENT = 1` /
   * `DBCC CHECKIDENT (table, RESEED, 0)`); the printer refuses if set
   * there.
   */
  restartIdentity?: boolean
  /**
   * PG only — emit `CONTINUE IDENTITY` explicitly. This is the SQL
   * standard default behaviour and the printer normally omits the
   * keyword, but the slot exists so the builder can distinguish "user
   * asked for default" from "user asked for restart". Mutually
   * exclusive with {@link restartIdentity}.
   */
  continueIdentity?: boolean
  /**
   * PG only — emit `CASCADE`. Without it the engine refuses to
   * truncate a table that is referenced by another table's foreign
   * key (the default `RESTRICT` behaviour). MySQL / MSSQL have no
   * cascade form on TRUNCATE and the printer refuses if set there.
   * Mutually exclusive with {@link restrict}.
   */
  cascade?: boolean
  /**
   * PG only — emit `RESTRICT` explicitly. This is the SQL standard
   * default behaviour; the printer normally omits the keyword, but
   * the slot exists for symmetry with {@link cascade}. Mutually
   * exclusive with {@link cascade}.
   */
  restrict?: boolean
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

// ── CREATE SEQUENCE ──

/**
 * PG / MSSQL first-class `CREATE SEQUENCE` — a free-standing
 * monotonic integer source. Useful for advisory IDs, batch numbers, or
 * any counter that needs to outlive a particular table's lifecycle
 * (auto-increment / IDENTITY columns are scoped to their owning table;
 * sequences are not).
 *
 * Grammar (loose superset across PG and MSSQL):
 *
 *     CREATE SEQUENCE [IF NOT EXISTS] <name>
 *       [AS <int_type>]                       -- smallint / integer / bigint
 *       [INCREMENT [BY] <step>]               -- default 1
 *       [MINVALUE <n> | NO MINVALUE]
 *       [MAXVALUE <n> | NO MAXVALUE]
 *       [START [WITH] <n>]
 *       [CACHE <n> | NO CACHE]                -- batch size; MSSQL NO CACHE
 *       [CYCLE | NO CYCLE]
 *       [OWNED BY { table.column | NONE }]    -- PG only
 *
 * Divergence the printer handles:
 *
 *  - `OWNED BY` is PG-only (drops sequence when the owning column is
 *    dropped). MSSQL has no analogue; the printer refuses if set.
 *  - `IF NOT EXISTS` is PG-only on this statement. MSSQL has no first-
 *    class form and the printer refuses.
 *  - `minValue`/`maxValue` use `null` to mean "NO MINVALUE/MAXVALUE";
 *    `undefined` means "default for the data type".
 *
 * SQLite and MySQL have no sequence object at all — both refuse via the
 * `SEQUENCES` feature flag.
 */
export interface CreateSequenceNode {
  type: "create_sequence"
  name: string
  schema?: string
  ifNotExists?: boolean
  /** `AS <int_type>` — `smallint` / `integer` / `bigint`. */
  dataType?: string
  /** `INCREMENT BY <n>`. Negative values reverse the sequence. */
  increment?: number
  /** `MINVALUE <n>` when a number; `null` → `NO MINVALUE`; `undefined` → default. */
  minValue?: number | null
  /** `MAXVALUE <n>` when a number; `null` → `NO MAXVALUE`; `undefined` → default. */
  maxValue?: number | null
  /** `START WITH <n>`. */
  start?: number
  /** `CACHE <n>` — pre-allocate that many values per session. */
  cache?: number
  /** `CYCLE` (wrap on overflow) when true; `NO CYCLE` when false. */
  cycle?: boolean
  /**
   * `OWNED BY <table>.<column> | NONE` — PG only. When the owning
   * column / table is dropped, PG drops the sequence too. The literal
   * string `"NONE"` clears any existing ownership. MSSQL has no
   * equivalent; the printer refuses if set on that dialect.
   */
  ownedBy?: { table: string; column: string } | "NONE"
}

// ── DROP SEQUENCE ──

/**
 * `DROP SEQUENCE [IF EXISTS] <name> [CASCADE | RESTRICT]`. PG and
 * MSSQL accept the same grammar (modulo PG-only `CASCADE`). MySQL and
 * SQLite have no sequence object; the printer refuses via the
 * `SEQUENCES` feature flag.
 */
export interface DropSequenceNode {
  type: "drop_sequence"
  name: string
  schema?: string
  ifExists?: boolean
  /**
   * `CASCADE` — PG only. MSSQL has no cascade form on `DROP SEQUENCE`
   * (sequences aren't referentially linked to dependents the way tables
   * are); the printer refuses if set on that dialect.
   */
  cascade?: boolean
}

// ── ALTER SEQUENCE ──

/**
 * `ALTER SEQUENCE` — change a sequence's properties post-creation. The
 * common workflows are resetting the current value (`RESTART [WITH n]`),
 * changing the increment / start, retuning the cache size, or toggling
 * cycle behaviour. PG and MSSQL both ship the statement; MySQL and
 * SQLite have no sequence object at all — the printer refuses via the
 * `SEQUENCES` feature flag.
 *
 * Grammar (loose superset across PG and MSSQL):
 *
 *     ALTER SEQUENCE [IF EXISTS] <name>
 *       [AS <int_type>]                        -- PG only on ALTER
 *       [INCREMENT [BY] <step>]
 *       [MINVALUE <n> | NO MINVALUE]
 *       [MAXVALUE <n> | NO MAXVALUE]
 *       [START [WITH] <n>]                     -- PG only on ALTER
 *       [RESTART [[WITH] <n>]]
 *       [CACHE <n> | NO CACHE]                 -- NO CACHE is MSSQL-only
 *       [CYCLE | NO CYCLE]
 *       [OWNED BY { table.column | NONE }]     -- PG only
 *
 * Divergence the printer handles:
 *
 *  - `IF EXISTS` — PG only on `ALTER SEQUENCE`. MSSQL has no first-class
 *    form on this statement and the printer refuses.
 *  - `AS <int_type>` — PG only on `ALTER SEQUENCE`. MSSQL has no
 *    grammar for changing the data type after creation; the printer
 *    refuses if set there.
 *  - `START WITH` — PG only on `ALTER SEQUENCE`. MSSQL has no
 *    equivalent on ALTER (set it at CREATE time or via `RESTART`).
 *  - `OWNED BY` — PG only.
 *  - `NO CACHE` — MSSQL form. PG has no `NO CACHE` keyword on ALTER;
 *    pass `cache: 1` (the implicit minimum) instead.
 *  - `minValue` / `maxValue`: `null` → `NO MINVALUE` / `NO MAXVALUE`,
 *    `undefined` → leave unchanged.
 *  - `cache`: `null` → `NO CACHE` (MSSQL only), `undefined` → leave
 *    unchanged.
 *
 * For the first cut we expose only the option-changing forms — RENAME,
 * SET SCHEMA, OWNER TO each need a distinct AST shape and are
 * deferred. PG's `ALTER SEQUENCE … RENAME TO …` etc. live on a
 * separate roadmap entry.
 */
export interface AlterSequenceNode {
  type: "alter_sequence"
  name: string
  schema?: string
  /**
   * `IF EXISTS` — PG only on `ALTER SEQUENCE`. MSSQL has no first-class
   * form; the printer refuses if set on that dialect.
   */
  ifExists?: boolean
  /**
   * `AS <int_type>` — PG only on `ALTER SEQUENCE`. MSSQL has no
   * grammar for changing the data type after creation; the printer
   * refuses if set there.
   */
  dataType?: string
  /** `INCREMENT BY <n>`. Negative values reverse the sequence. */
  increment?: number
  /** `MINVALUE <n>` when a number; `null` → `NO MINVALUE`; `undefined` → unchanged. */
  minValue?: number | null
  /** `MAXVALUE <n>` when a number; `null` → `NO MAXVALUE`; `undefined` → unchanged. */
  maxValue?: number | null
  /**
   * `START WITH <n>` — PG only on `ALTER SEQUENCE`. Note that PG only
   * applies this to the sequence's *recorded start*; the next value
   * produced is still determined by the current sequence state until a
   * `RESTART` is issued. MSSQL has no `START WITH` clause on `ALTER
   * SEQUENCE`; the printer refuses if set there.
   */
  start?: number
  /**
   * `RESTART` (current value reset to the recorded start) or
   * `RESTART WITH <n>` (current value reset to the given number).
   * `restart: true` → bare `RESTART`; `restart: { value: n }` →
   * `RESTART WITH n`; `undefined` → no restart clause emitted.
   */
  restart?: true | { value: number }
  /**
   * `CACHE <n>` when a number; `null` → `NO CACHE` (MSSQL only — PG
   * has no `NO CACHE` keyword on ALTER); `undefined` → unchanged.
   */
  cache?: number | null
  /** `CYCLE` when true; `NO CYCLE` when false; `undefined` → unchanged. */
  cycle?: boolean
  /**
   * `OWNED BY <table>.<column> | NONE` — PG only. MSSQL has no
   * equivalent on ALTER; the printer refuses if set on that dialect.
   */
  ownedBy?: { table: string; column: string } | "NONE"
}

// ── VACUUM / ANALYZE / REINDEX (PG maintenance) ──

/**
 * PostgreSQL `VACUUM [ ( option [, ...] ) ] [ table_and_columns [, ...] ]`.
 *
 * Reclaims storage left over by dead tuples and (with `ANALYZE`) refreshes
 * the planner statistics. Without a table list it runs against every
 * non-shared table in the current database — useful for nightly cron, but
 * heavy on shared infrastructure. Per-table form is preferred during
 * online operation.
 *
 * Grammar (loose superset of PG 14+ option list — the first-cut surface
 * exposes the high-value options only):
 *
 *     VACUUM [ ( FULL [bool], FREEZE [bool], VERBOSE [bool],
 *                 ANALYZE [bool], SKIP_LOCKED [bool], TRUNCATE [bool] ) ]
 *            [ table_and_columns [, ...] ]
 *
 * Divergence the printer handles:
 *
 *  - **PG only.** MySQL has an unrelated `OPTIMIZE TABLE` with a different
 *    surface; SQLite's `VACUUM` is whole-database and option-less; MSSQL
 *    has no VACUUM at all (its equivalent is `DBCC SHRINKDATABASE` /
 *    `DBCC SHRINKFILE`). The printer refuses on all three dialects rather
 *    than emit SQL the engine rejects or — worse — silently misinterprets.
 *
 *  - `tables` empty array (`[]`) and `tables: undefined` are both treated
 *    as "whole database" — the printer omits the table list either way.
 *
 *  - `FULL` rewrites the table on disk and takes an `ACCESS EXCLUSIVE`
 *    lock for the duration; never run on production tables during traffic.
 *
 *  - `ANALYZE` is independent of `FULL`; the common operational shape is
 *    `VACUUM ANALYZE table` to reclaim + refresh stats in one shot.
 *
 *  - `SKIP_LOCKED` (PG 12+) skips tables / rows it can't get the lock on
 *    without blocking — useful inside maintenance windows that have a
 *    soft deadline.
 */
export interface VacuumNode {
  type: "vacuum"
  /**
   * One or more tables to vacuum. Empty / undefined means "every table
   * in the current database" (PG's default). Multi-table form is PG
   * only — the printer accepts comma-separated lists straight through.
   */
  tables?: string[]
  /** `FULL` — rewrite the table on disk (takes ACCESS EXCLUSIVE lock). */
  full?: boolean
  /** `FREEZE` — aggressively freeze tuples, equivalent to `vacuum_freeze_min_age = 0`. */
  freeze?: boolean
  /** `VERBOSE` — print progress to the server log / client. */
  verbose?: boolean
  /** `ANALYZE` — refresh planner statistics in the same pass. */
  analyze?: boolean
  /** `SKIP_LOCKED` — skip tables / rows it can't lock immediately (PG 12+). */
  skipLocked?: boolean
  /**
   * `TRUNCATE` — truncate the trailing empty pages back to the OS.
   * Defaults to ON in PG; this flag lets a caller opt out via
   * `TRUNCATE FALSE` in the option list, which the printer emits as
   * `TRUNCATE FALSE` (PG 12+).
   */
  truncate?: boolean
}

/**
 * PostgreSQL `ANALYZE [ ( option [, ...] ) ] [ table_and_columns [, ...] ]`.
 *
 * Refreshes the planner's statistics without reclaiming storage. Same
 * dialect-only-PG story as `VACUUM` — MSSQL has `UPDATE STATISTICS` and
 * MySQL has `ANALYZE TABLE` with a different grammar; SQLite has
 * `ANALYZE` but no option list. For first cut: PG only. MySQL/SQLite/MSSQL
 * refuse at print time.
 */
export interface AnalyzeNode {
  type: "analyze"
  /** Empty / undefined → analyze every table in the database. */
  tables?: string[]
  /** `VERBOSE` — print progress to the server log / client. */
  verbose?: boolean
  /** `SKIP_LOCKED` — skip tables it can't lock immediately (PG 12+). */
  skipLocked?: boolean
}

/**
 * PostgreSQL `REINDEX [ ( option ) ] { INDEX | TABLE | SCHEMA |
 * DATABASE | SYSTEM } [ CONCURRENTLY ] name`.
 *
 * Rebuilds one or more indexes — useful after a corruption suspicion, a
 * bloat purge, or when changing the index access method (drop and
 * recreate is usually cleaner for the last case, but REINDEX wins when
 * the index name needs to stay stable). `CONCURRENTLY` (PG 12+) does the
 * rebuild without blocking writes; it requires twice the disk space for
 * the duration and can't run inside a transaction.
 *
 * Dialect support:
 *
 *  - **PG only.** MSSQL has `ALTER INDEX … REBUILD`, MySQL has
 *    `OPTIMIZE TABLE` and `ALTER TABLE … FORCE` for table-level rebuilds,
 *    SQLite has `REINDEX` but the grammar is `REINDEX [name]` — no
 *    target keywords, no `CONCURRENTLY`. The first cut refuses on every
 *    non-PG dialect; dialect-aware variants need separate AST nodes.
 */
export interface ReindexNode {
  type: "reindex"
  /**
   * What to rebuild. `INDEX` / `TABLE` / `SCHEMA` / `DATABASE` /
   * `SYSTEM` map 1:1 to the PG keywords; the printer emits the keyword
   * verbatim after validating the chosen target against this set.
   */
  target: "INDEX" | "TABLE" | "SCHEMA" | "DATABASE" | "SYSTEM"
  /**
   * Identifier of the target object (index / table / schema /
   * database name). The printer quotes it via the standard
   * `quoteIdentifier` helper.
   */
  name: string
  /**
   * `CONCURRENTLY` — non-blocking rebuild (PG 12+). Refused at print
   * time when `target` is `SYSTEM` since PG itself forbids it on the
   * system catalogs; for `DATABASE` PG also refuses, but we surface
   * the error from the engine rather than pre-empt every catalog
   * detail here.
   */
  concurrently?: boolean
  /** `VERBOSE` — print progress to the server log / client. */
  verbose?: boolean
}

// ── CREATE POLICY / DROP POLICY (PG Row Level Security) ──

/**
 * PostgreSQL `CREATE POLICY <name> ON <table> [AS PERMISSIVE | RESTRICTIVE]
 * [FOR { ALL | SELECT | INSERT | UPDATE | DELETE }] [TO role[, ...]]
 * [USING (expr)] [WITH CHECK (expr)]`.
 *
 * Row Level Security policies attach per-row access predicates to a
 * table — once RLS is enabled (`ALTER TABLE … ENABLE ROW LEVEL
 * SECURITY`), the policies' `USING` clauses filter what existing rows
 * are visible, and the `WITH CHECK` clauses gate which rows can be
 * written. Multiple policies layer:
 *
 *  - PERMISSIVE policies (the default) are OR'd together — a row is
 *    visible if *any* permissive policy allows it.
 *  - RESTRICTIVE policies are AND'd with the OR'd permissive set — a
 *    row is visible only if *every* restrictive policy allows it.
 *
 * Common multi-tenant pattern:
 *
 *     -- after ALTER TABLE orders ENABLE ROW LEVEL SECURITY
 *     CREATE POLICY tenant_isolation ON orders
 *       FOR ALL
 *       USING (tenant_id = current_setting('app.tenant_id')::int)
 *       WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);
 *
 * Dialect support: **PG only.** MySQL / SQLite / MSSQL have no
 * equivalent row-policy grammar (MSSQL's "Row-Level Security" feature
 * is implemented via security policy objects + predicate functions,
 * not via per-table CREATE POLICY statements; surfacing it cleanly
 * needs a dedicated AST node). The DDL printer refuses on every
 * non-PG dialect.
 */
export interface CreatePolicyNode {
  type: "create_policy"
  name: string
  table: string
  schema?: string
  /**
   * Policy kind. `permissive` (the default in PG; `AS PERMISSIVE` is
   * the explicit form) means the policy contributes to the OR-set;
   * `restrictive` (`AS RESTRICTIVE`) means it AND-joins the
   * permissive set. Setting both is a builder-side mistake — the
   * printer refuses.
   */
  permissive?: boolean
  restrictive?: boolean
  /**
   * `FOR { ALL | SELECT | INSERT | UPDATE | DELETE }` — which DML
   * commands the policy applies to. Default (`undefined`) is `ALL`
   * which PG omits from the emitted DDL.
   */
  forCommand?: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE"
  /**
   * `TO role_name [, ...]` — roles the policy applies to. Each entry
   * is emitted via `quoteIdentifier`, except for the three reserved
   * keywords `PUBLIC` / `CURRENT_USER` / `SESSION_USER` (case-
   * insensitive match) which are passed through verbatim. Omitting
   * the slot (or passing an empty array) skips the `TO` clause — PG
   * defaults to `PUBLIC` in that case.
   */
  roles?: string[]
  /**
   * `USING (<expr>)` — predicate applied to existing rows (for
   * SELECT, UPDATE, DELETE). When the predicate evaluates to TRUE the
   * row is visible / mutable through this policy.
   */
  using?: ExpressionNode
  /**
   * `WITH CHECK (<expr>)` — predicate applied to new / updated rows
   * (for INSERT, UPDATE). When the predicate evaluates to FALSE the
   * write is rejected. If omitted on a policy that allows writes, PG
   * falls back to the USING predicate.
   */
  withCheck?: ExpressionNode
}

/**
 * PostgreSQL `DROP POLICY [IF EXISTS] <name> ON <table> [CASCADE |
 * RESTRICT]`. Same dialect story as {@link CreatePolicyNode} — PG
 * only; the DDL printer refuses on every non-PG dialect.
 */
export interface DropPolicyNode {
  type: "drop_policy"
  name: string
  table: string
  schema?: string
  ifExists?: boolean
  /**
   * `CASCADE` — PG accepts it on `DROP POLICY` though there are no
   * dependent objects in the standard graph; the keyword is a
   * compatibility no-op. The printer emits it when set so the AST
   * round-trips through introspection cleanly.
   */
  cascade?: boolean
}

/**
 * PostgreSQL `ALTER POLICY <name> ON <table>` — modify an existing RLS
 * policy in-place rather than DROP + CREATE. Two distinct forms share
 * the same node:
 *
 *  - **Rename form**: `ALTER POLICY <name> ON <table> RENAME TO
 *    <new_name>`. Only {@link renameTo} is set; the modify-form slots
 *    are all undefined. PG refuses any other clause alongside `RENAME
 *    TO`, and so does the printer at print time.
 *  - **Modify form**: `ALTER POLICY <name> ON <table>
 *    [ TO role[, ...] ]
 *    [ USING (<expr>) ]
 *    [ WITH CHECK (<expr>) ]`.
 *    Any combination of {@link roles}, {@link using}, and
 *    {@link withCheck} may be set; at least one must be set or PG
 *    rejects the statement (the printer surfaces a clearer error).
 *
 * The policy *kind* (permissive vs restrictive) and the *command* it
 * applies to (`FOR ALL` / `SELECT` / …) are immutable in PG —
 * `ALTER POLICY` has no syntax for changing them. To change those you
 * have to DROP + CREATE the policy.
 *
 * Dialect support: **PG only.** Reuses the `ROW_LEVEL_SECURITY`
 * feature flag from `CREATE POLICY` / `DROP POLICY`.
 */
export interface AlterPolicyNode {
  type: "alter_policy"
  name: string
  table: string
  schema?: string
  /**
   * Rename form — `RENAME TO <new_name>`. Mutually exclusive with the
   * modify-form slots ({@link roles}, {@link using}, {@link withCheck})
   * — the printer refuses if both are populated.
   */
  renameTo?: string
  /**
   * `TO role_name [, ...]` — replace the applied-roles list. Each
   * entry is emitted via `quoteIdentifier`, except for the three
   * reserved keywords `PUBLIC` / `CURRENT_USER` / `SESSION_USER`
   * (case-insensitive match) which are passed through verbatim.
   * Setting an empty array is treated as "no `TO` clause to emit" —
   * which the printer rejects since `ALTER POLICY` requires at least
   * one alterable clause; pass `undefined` instead to leave roles
   * unchanged.
   */
  roles?: string[]
  /**
   * `USING (<expr>)` — replace the policy's existing-row predicate.
   * Same `ExpressionNode` surface as `CREATE POLICY`.
   */
  using?: ExpressionNode
  /**
   * `WITH CHECK (<expr>)` — replace the policy's new-row predicate.
   * Same `ExpressionNode` surface as `CREATE POLICY`.
   */
  withCheck?: ExpressionNode
}

// ── CREATE EXTENSION ──

/**
 * `CREATE EXTENSION [IF NOT EXISTS] extension_name
 *  [ WITH ] [ SCHEMA schema_name ] [ VERSION version ] [ CASCADE ]`.
 *
 * PostgreSQL-only DDL — loads a contrib extension (pgcrypto, uuid-ossp,
 * btree_gist, postgis, pg_trgm, …) into the current database. MySQL /
 * SQLite / MSSQL have no equivalent: the printer throws
 * {@link UnsupportedDialectFeatureError} on those dialects rather than
 * emitting SQL the engine will reject.
 *
 * - `name`: the extension identifier (validated as a SQL identifier to
 *   keep injection out of the unquoted name slot).
 * - `version`: optional `VERSION '<v>'` clause. Validated by a stricter
 *   regex (`[A-Za-z0-9._-]+`) since real extension versions contain
 *   dots and hyphens.
 * - `cascade`: also create any extensions this one depends on (`pgcrypto`
 *   for example pulls in nothing today, but PostGIS pulls in `fuzzystrmatch`).
 */
export interface CreateExtensionNode {
  type: "create_extension"
  name: string
  ifNotExists?: boolean
  schema?: string
  version?: string
  cascade?: boolean
}

// ── DROP EXTENSION ──

/**
 * `DROP EXTENSION [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`.
 *
 * PostgreSQL-only DDL — removes one or more extensions from the
 * database. The grammar permits a comma-separated list of names; we
 * preserve that. `CASCADE` drops dependent objects automatically;
 * `RESTRICT` (the default) refuses if anything depends on the
 * extension. The two flags are mutually exclusive and the printer
 * rejects emitting both.
 */
export interface DropExtensionNode {
  type: "drop_extension"
  names: string[]
  ifExists?: boolean
  cascade?: boolean
  restrict?: boolean
}

// ── CREATE TYPE AS ENUM ──

/**
 * `CREATE TYPE name AS ENUM ('val1', 'val2', ...)`.
 *
 * PostgreSQL-only DDL — declares a static enumerated label type usable
 * anywhere a base type would be (column data type, function argument,
 * domain base). Unlike the inline `enum(...)` column shape produced by
 * `enumType()`, this creates a *named* type that survives across
 * tables. The declared label order is also the sort order, which is
 * occasionally load-bearing in queries (`ORDER BY status` ordering by
 * the enum values' declared sequence rather than lexicographic text).
 *
 * MySQL has inline `ENUM(...)` as a column shape only (no `CREATE TYPE`
 * grammar); SQLite has no enum type at all; MSSQL's `CREATE TYPE` is a
 * different shape (`AS TABLE` or `FROM existing_type`). The printer
 * refuses on every non-PG dialect.
 *
 * - `name`: the enum type identifier (validated as a SQL identifier).
 * - `values`: declared label set. The order is preserved verbatim and
 *   becomes the sort order in PG. Each label is escaped via
 *   `escapeStringLiteral` before being spliced into the emitted DDL.
 */
export interface CreateTypeEnumNode {
  type: "create_type_enum"
  name: string
  values: string[]
}

// ── DROP TYPE ──

/**
 * `DROP TYPE [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`.
 *
 * PostgreSQL-only DDL — removes one or more named types (enum, domain,
 * composite, range, base). The grammar permits a comma-separated list
 * of names; we preserve that. `CASCADE` drops dependent objects
 * automatically (rare in practice — a column that uses the type would
 * have to be dropped or altered too); `RESTRICT` (the default) refuses
 * if anything depends on the type. The two flags are mutually
 * exclusive and the printer rejects emitting both.
 */
export interface DropTypeNode {
  type: "drop_type"
  names: string[]
  ifExists?: boolean
  cascade?: boolean
  restrict?: boolean
}

// ── CREATE DOMAIN ──

/**
 * `CREATE DOMAIN name AS data_type [DEFAULT expr]
 *   [[CONSTRAINT cname] { NOT NULL | CHECK (expr) }]`.
 *
 * PostgreSQL-only DDL — declares a typed constraint wrapper around an
 * existing type. Domains let you bundle a base type with a validation
 * rule (CHECK) and an optional default, and reuse that bundle as a
 * column type across many tables — e.g. `CREATE DOMAIN positive_int AS
 * integer CHECK (VALUE > 0)` once, then `salary positive_int NOT NULL`
 * in every table that needs it.
 *
 * - `name`: the domain identifier (validated as a SQL identifier).
 * - `dataType`: the underlying base type (validated via `validateDataType`).
 * - `defaultExpression`: optional `DEFAULT <expr>` clause. Renders
 *   through the same DDL expression printer as `CHECK` does.
 * - `notNull`: emits `NOT NULL` — PG treats this as a separate
 *   constraint kind, distinct from the column-level NOT NULL.
 * - `check`: optional `CHECK (<expr>)`. Inside the expression, the
 *   special identifier `VALUE` refers to the value being checked —
 *   render that via a `column_ref` to `"VALUE"` or `sql\`VALUE > 0\``.
 * - `checkConstraintName`: optional `CONSTRAINT <name>` prefix for the
 *   CHECK clause (lets you reference it later for `ALTER DOMAIN`).
 *
 * MySQL `CREATE DOMAIN` is parsed but treated as `CREATE TYPE` (no
 * domain semantics); SQLite has no domain grammar; MSSQL has alias
 * types (`CREATE TYPE name FROM base`) which is a different surface.
 * The printer refuses on every non-PG dialect.
 */
export interface CreateDomainNode {
  type: "create_domain"
  name: string
  dataType: string
  defaultExpression?: ExpressionNode
  notNull?: boolean
  check?: ExpressionNode
  checkConstraintName?: string
}

// ── DROP DOMAIN ──

/**
 * `DROP DOMAIN [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`.
 *
 * PostgreSQL-only DDL — removes one or more domains. Like `DROP TYPE`,
 * the grammar permits a comma-separated list. `CASCADE` and `RESTRICT`
 * are mutually exclusive and the printer rejects emitting both.
 */
export interface DropDomainNode {
  type: "drop_domain"
  names: string[]
  ifExists?: boolean
  cascade?: boolean
  restrict?: boolean
}

// ── ALTER TYPE ADD VALUE ──

/**
 * `ALTER TYPE name ADD VALUE [IF NOT EXISTS] 'new_value'
 *   [ BEFORE 'existing' | AFTER 'existing' ]`.
 *
 * PostgreSQL-only DDL — extends an existing enum type with a new label,
 * optionally positioned relative to an existing label. Without the
 * `BEFORE` / `AFTER` clause the new label is appended at the end (and
 * sorts after every existing label).
 *
 * Important PG quirk: in PG 11 and earlier, `ALTER TYPE … ADD VALUE`
 * **cannot** run inside a transaction block at all. PG 12+ relaxed that
 * but the newly-added value still isn't visible to the transaction
 * that added it until commit — so it remains discouraged inside the
 * same migration step that uses it. Typical workflow: emit the
 * `ALTER TYPE` as its own one-shot migration, *then* use the new value
 * in a subsequent step. Multiple `ADD VALUE` statements on the same
 * type within one transaction are also rejected by PG even in 12+.
 *
 * `IF NOT EXISTS` (PG 9.6+) makes the statement idempotent — if the
 * label already exists on the enum, the statement is a no-op rather
 * than a syntax-level error.
 *
 * MySQL has no equivalent (its inline `ENUM(...)` column shape changes
 * via `ALTER TABLE … MODIFY COLUMN`, a different surface); SQLite has
 * no enum at all; MSSQL's `CREATE TYPE` is a different surface entirely.
 * The DDL printer refuses on every non-PG dialect.
 */
export interface AlterTypeAddValueNode {
  type: "alter_type_add_value"
  name: string
  value: string
  ifNotExists?: boolean
  /**
   * Optional positioning of the new label relative to an existing one.
   * Without it, PG appends the new label at the end of the declared
   * order (which is also the sort order).
   */
  position?: { kind: "BEFORE" | "AFTER"; existing: string }
}

// ── ALTER TYPE RENAME ──

/**
 * `ALTER TYPE name RENAME TO new_name`.
 *
 * PostgreSQL-only DDL — renames an existing custom type (enum, domain,
 * composite, range, base) in place. Every column, function argument, and
 * cast that references the old name continues to work after the rename:
 * PG resolves these by the type's stable OID, not by the textual name,
 * so dropping a table and recreating it after a rename is unnecessary
 * (and would lose data).
 *
 * The new name must not collide with any other type, table, view, or
 * sequence in the same schema — PG keeps types in the same namespace as
 * relations. Catalog lookups (`pg_type.typname`) and any tooling that
 * displays the type name (psql `\dT`, ORM schemas regenerated post-
 * rename) reflect the new name immediately.
 *
 * Unlike `ALTER TYPE … ADD VALUE`, this statement is fully
 * transactional and safe inside a migration step — the rename itself is
 * just a single tuple update on `pg_type`.
 *
 * MySQL / SQLite have no equivalent (no user-defined named types of
 * this shape). MSSQL has `sp_rename N'oldType', N'newType', N'USERDATATYPE'`
 * but that operates on alias types only, a different surface. The DDL
 * printer refuses on every non-PG dialect.
 */
export interface AlterTypeRenameNode {
  type: "alter_type_rename"
  name: string
  newName: string
}

// ── ALTER TYPE RENAME VALUE ──

/**
 * `ALTER TYPE name RENAME VALUE 'old_label' TO 'new_label'`.
 *
 * PostgreSQL-only DDL — renames a single label on an existing enum type.
 * PG 10+ feature. Rows that already store the old label *keep their
 * stored representation* (enum values are stored by OID, not by label
 * string), so a rename is essentially free at the data layer and does
 * not rewrite any tables.
 *
 * The new label must not already exist on the same enum (PG raises
 * `enum label "new" already exists` if it does). Unlike `ADD VALUE`,
 * there's no `IF NOT EXISTS` / idempotency clause — re-running a
 * migration that already renamed the label raises `enum label "old"
 * does not exist`. Sumak emits the statement verbatim; migrators that
 * need idempotency wrap the call in a catalog probe of `pg_enum`.
 *
 * Both labels are escaped through `escapeStringLiteral` at print time —
 * a label like `O'Brien` is safe to splice into either side. The type
 * name flows through `validateFunctionName`.
 *
 * This statement is fully transactional (unlike `ADD VALUE`) and safe
 * to batch with other migration steps inside a single `BEGIN … COMMIT`.
 *
 * MySQL has no equivalent (its inline `ENUM(...)` column shape changes
 * via `ALTER TABLE … MODIFY COLUMN`, which rewrites the column);
 * SQLite has no enum; MSSQL has no enum either. The DDL printer refuses
 * on every non-PG dialect.
 */
export interface AlterTypeRenameValueNode {
  type: "alter_type_rename_value"
  name: string
  oldValue: string
  newValue: string
}

// ── LOCK TABLE (PG advisory locking) ──

/**
 * PostgreSQL `LOCK [TABLE] [ONLY] name [*] [, ...] [IN lock_mode MODE]
 * [NOWAIT]`. Standalone statement used inside an explicit transaction
 * to take a named table-level lock on one or more tables — the
 * "explicit advisory locking" pattern for serializing critical sections
 * that can't tolerate optimistic concurrency.
 *
 * The eight valid `lock_mode` values map 1:1 to the PG keywords:
 *
 *  - `ACCESS SHARE` — implicit lock on `SELECT`. Conflicts only with
 *    `ACCESS EXCLUSIVE`.
 *  - `ROW SHARE` — implicit lock on `SELECT … FOR UPDATE / SHARE`.
 *  - `ROW EXCLUSIVE` — implicit lock on `INSERT / UPDATE / DELETE`.
 *  - `SHARE UPDATE EXCLUSIVE` — implicit lock on `VACUUM (without FULL)`,
 *    `ANALYZE`, `CREATE INDEX CONCURRENTLY`, …
 *  - `SHARE` — implicit lock on `CREATE INDEX (without CONCURRENTLY)`.
 *    Mutually exclusive with itself across sessions — used to block
 *    concurrent writes while reads continue.
 *  - `SHARE ROW EXCLUSIVE` — like `SHARE` but also self-conflicting.
 *  - `EXCLUSIVE` — blocks all locks except `ACCESS SHARE`.
 *  - `ACCESS EXCLUSIVE` — implicit lock on `DROP TABLE`, `TRUNCATE`,
 *    `REINDEX`, `ALTER TABLE`, `VACUUM FULL`, `REFRESH MATERIALIZED
 *    VIEW (without CONCURRENTLY)`. The default when no `IN … MODE` is
 *    given — `LOCK TABLE foo;` and `LOCK TABLE foo IN ACCESS EXCLUSIVE
 *    MODE;` are equivalent. Blocks every other lock.
 *
 * `NOWAIT` makes the statement fail immediately rather than wait if the
 * lock can't be acquired right away — useful for "try-lock" patterns
 * where the caller would rather report failure than block.
 *
 * PG only. MSSQL has no equivalent statement (uses table hints like
 * `WITH (TABLOCK)` on individual queries). MySQL has `LOCK TABLES name
 * READ|WRITE` with a different grammar (no `IN … MODE`, no `NOWAIT`)
 * and different transaction semantics — refused for the first cut.
 * SQLite has no equivalent at all.
 */
export interface LockTableNode {
  type: "lock_table"
  /**
   * One or more tables to lock. PG accepts a comma-separated list in a
   * single statement and applies the same mode + nowait flag to each.
   */
  tables: string[]
  /**
   * `ONLY` — skip table inheritance descendants. Without it PG locks
   * the named table *and* every table that inherits from it; with it
   * only the named relation is locked. Applies uniformly to every name
   * in the table list (the per-name `ONLY` form isn't surfaced here for
   * the first cut).
   */
  only?: boolean
  /**
   * Lock mode keyword. When undefined the printer emits no `IN … MODE`
   * clause, which means PG falls back to its default `ACCESS EXCLUSIVE`.
   */
  mode?:
    | "ACCESS SHARE"
    | "ROW SHARE"
    | "ROW EXCLUSIVE"
    | "SHARE UPDATE EXCLUSIVE"
    | "SHARE"
    | "SHARE ROW EXCLUSIVE"
    | "EXCLUSIVE"
    | "ACCESS EXCLUSIVE"
  /**
   * `NOWAIT` — fail immediately if the lock can't be taken instead of
   * waiting. Useful for opportunistic try-lock patterns where the
   * caller prefers a fast error over an indefinite wait.
   */
  noWait?: boolean
}

// ── COPY (bulk import / export) ──

/**
 * PostgreSQL `COPY` — bulk row transfer between a table (or a SELECT)
 * and a client-streamed `STDIN` / `STDOUT` channel. The fast path for
 * loading or extracting large data sets — orders of magnitude faster
 * than per-row `INSERT` because PG bypasses the SQL planner per row and
 * batches the parse / write into a binary protocol message.
 *
 * Two directions share the same node:
 *
 *  - `direction: "from"` — `COPY table [(cols)] FROM STDIN [WITH (...)]`.
 *    Requires {@link table}; {@link query} is rejected. The client side
 *    (sumak's driver layer) is responsible for streaming row data into
 *    the connection's COPY protocol channel after the statement is
 *    issued. The printer only emits the statement itself.
 *  - `direction: "to"` — `COPY { table [(cols)] | (query) } TO STDOUT
 *    [WITH (...)]`. Accepts either a table (with optional column list)
 *    or an embedded SELECT — the query form is the only way to filter,
 *    join, or transform on the way out. {@link source} must be
 *    `STDOUT`.
 *
 * Grammar (loose superset across PG):
 *
 *     COPY table [ (col [, ...]) ]
 *       FROM STDIN
 *       [ [ WITH ] ( option [, ...] ) ]
 *
 *     COPY { table [ (col [, ...]) ] | (query) }
 *       TO STDOUT
 *       [ [ WITH ] ( option [, ...] ) ]
 *
 *     where option is one of:
 *       FORMAT { TEXT | CSV | BINARY }
 *       FREEZE [ boolean ]
 *       DELIMITER 'd'
 *       NULL 'string'
 *       HEADER [ MATCH | boolean ]
 *       QUOTE 'q'
 *       ESCAPE 'e'
 *       ENCODING 'enc'
 *
 * Scope of the first cut:
 *
 *  - **`STDIN` / `STDOUT` only.** Server-side file paths require
 *    superuser and are rarely usable from client code; `PROGRAM 'cmd'`
 *    runs arbitrary shell on the server and is a security hazard. Both
 *    are deferred — the printer rejects any other source/destination at
 *    compile time.
 *  - **PostgreSQL only.** MySQL has `LOAD DATA INFILE` (a different
 *    statement with file-path / character-set / line-terminator
 *    surface), SQLite has the `.import` / `.export` shell commands
 *    (CLI-only, not SQL), MSSQL has `BULK INSERT` and the `bcp` utility.
 *    Each is its own AST shape. The printer refuses on every non-PG
 *    dialect with a pointer at the dialect-native equivalent.
 *  - Options shipped: `FORMAT`, `FREEZE`, `DELIMITER`, `NULL`, `HEADER`,
 *    `QUOTE`, `ESCAPE`, `ENCODING`. The other PG options (`FORCE_QUOTE`,
 *    `FORCE_NOT_NULL`, `FORCE_NULL`, `ON_ERROR`, `LOG_VERBOSITY`,
 *    `WHERE`, the `DEFAULT` token, etc.) are deferred.
 *
 * Validation at print time:
 *
 *  - `direction === "from"` requires {@link table} and {@link source}
 *    === `"STDIN"`; the printer refuses the query form and any
 *    `STDOUT` source.
 *  - `direction === "to"` accepts either {@link table} or
 *    {@link query} (mutually exclusive) and requires {@link source}
 *    === `"STDOUT"`.
 *  - Option string slots (`delimiter`, `quote`, `escape`, `nullString`,
 *    `encoding`) flow through `escapeStringLiteral` so embedded quotes
 *    don't break out of the literal.
 */
export interface CopyNode {
  type: "copy"
  /**
   * Transfer direction. `"from"` → COPY FROM STDIN (bulk import);
   * `"to"` → COPY TO STDOUT (bulk export). The two forms share most
   * of the grammar but differ on what's allowed on the source/sink
   * side — see the {@link CopyNode} doc for the exact rules.
   */
  direction: "from" | "to"
  /**
   * The relation being read from / written into. Required for
   * `direction === "from"`. For `direction === "to"` exactly one of
   * {@link table} or {@link query} must be set — the query form is
   * the only path to filter or transform on export.
   *
   * `columns` is the optional column list `(c1, c2, …)`. PG uses it
   * to restrict the COPY to a subset of the table's columns (in the
   * given order); without it every column participates in the
   * declared table order. The same syntax applies to FROM and TO.
   */
  table?: { name: string; columns?: string[] }
  /**
   * Embedded SELECT for the `COPY (query) TO STDOUT` form — only
   * valid when `direction === "to"`. Mutually exclusive with
   * {@link table}; the printer refuses if both are set or both are
   * unset. The SELECT itself routes through the configured
   * SELECT printer (so plugins / hooks / normalize / optimize all
   * apply to the inner query just like `CREATE VIEW AS SELECT`).
   */
  query?: SelectNode
  /**
   * Where the data flows. `"STDIN"` is the only legal value when
   * `direction === "from"`; `"STDOUT"` is the only legal value when
   * `direction === "to"`. File paths and `PROGRAM 'cmd'` are
   * deferred (see the {@link CopyNode} doc) — the printer refuses
   * any other value.
   */
  source: "STDIN" | "STDOUT"
  /**
   * Optional `WITH ( option [, ...] )` payload. Options are emitted
   * in a stable order so two builds with the same inputs serialize
   * identically. String-valued options flow through
   * `escapeStringLiteral`.
   */
  options?: CopyOptions
}

/**
 * Option list for the COPY statement's `WITH ( ... )` clause. PG
 * accepts the legacy keyword form (`COPY ... CSV HEADER`) too, but
 * sumak emits the modern parenthesized form unconditionally — it's
 * unambiguous, version-stable, and the only form PG actively
 * documents as of PG 9.0+.
 *
 * Per-option detail:
 *
 *  - `format` — `FORMAT { TEXT | CSV | BINARY }`. Default is `TEXT`
 *    (PG's default). `CSV` is the common choice; `BINARY` is faster
 *    but tied to the exact PG version's wire format.
 *  - `freeze` — `FREEZE` (PG only on `COPY FROM`). Marks the imported
 *    tuples as frozen at load time, skipping the later VACUUM FREEZE
 *    pass. Requires the table to have been created or truncated in
 *    the same transaction; otherwise PG raises at execution.
 *  - `delimiter` — `DELIMITER 'd'`. Single-character separator
 *    between fields. Default is tab (`\t`) for `TEXT`, comma (`,`)
 *    for `CSV`.
 *  - `nullString` — `NULL 'string'`. Token representing a NULL in
 *    the data stream. Defaults to `\N` for TEXT, empty string for
 *    CSV.
 *  - `header` — `HEADER [ MATCH | true | false ]`. PG 12+ accepts
 *    the `MATCH` form which validates the first row against the
 *    column list; the older boolean form just skips (FROM) or emits
 *    (TO) a single header row.
 *  - `quote` — `QUOTE 'q'` (CSV-only at execution time, but the
 *    printer doesn't gate that — PG will tell the user if they pair
 *    it with `FORMAT TEXT`).
 *  - `escape` — `ESCAPE 'e'` (also CSV-only at execution time).
 *  - `encoding` — `ENCODING 'enc'`. Lets PG transcode the data
 *    stream — useful when the source isn't in the database's
 *    server_encoding.
 */
export interface CopyOptions {
  format?: "TEXT" | "CSV" | "BINARY"
  freeze?: boolean
  delimiter?: string
  nullString?: string
  header?: boolean | "MATCH"
  quote?: string
  escape?: string
  encoding?: string
}

// ── LISTEN / UNLISTEN / NOTIFY (PG asynchronous pubsub) ──

/**
 * PostgreSQL `LISTEN <channel_name>`. Subscribes the current session to
 * notifications sent on the named channel via {@link NotifyNode}.
 * Subsequent NOTIFY events arrive through the driver's async-notice
 * callback (in `node-postgres` that's `client.on('notification', cb)`).
 *
 * The channel name is a plain SQL identifier — not a string literal — so
 * it's quoted via {@link quoteIdentifier} at print time. Channel
 * subscriptions are scoped to the *session*, not the transaction; they
 * survive across `COMMIT` and `ROLLBACK` but disappear when the session
 * disconnects.
 *
 * Dialect support: **PG only.** MySQL / SQLite / MSSQL have nothing
 * comparable in core — MySQL `Channel`-style pubsub lives in plugins
 * (X Protocol notifications) and SQLite + MSSQL have no built-in
 * per-channel async notification mechanism at all. The DDL printer
 * refuses on every non-PG dialect via the `PUBSUB` feature gate.
 */
export interface ListenNode {
  type: "listen"
  channel: string
}

/**
 * PostgreSQL `UNLISTEN <channel_name>` or `UNLISTEN *`.
 *
 * Cancels a previous {@link ListenNode} subscription. The wildcard form
 * (`UNLISTEN *`) drops every channel the session is currently listening
 * on in a single statement — useful from a connection-release hook in a
 * pooled driver, so the next caller doesn't inherit a polluted
 * subscription set.
 *
 * Set `channel: "*"` for the wildcard form; everything else is treated
 * as a named identifier and quoted accordingly.
 *
 * Dialect support: **PG only.** Same `PUBSUB` feature gate as
 * {@link ListenNode}.
 */
export interface UnlistenNode {
  type: "unlisten"
  /**
   * Channel name to unsubscribe from, or the literal `"*"` to drop every
   * current subscription on the session. Named channels are validated
   * via `validateFunctionName` and quoted at print time; `"*"` is
   * emitted verbatim as the wildcard token.
   */
  channel: string
}

/**
 * PostgreSQL `NOTIFY <channel_name> [, '<payload>']`.
 *
 * Sends an asynchronous notification on the named channel. Any session
 * currently `LISTEN`-ing on that channel receives the notification with
 * the optional payload string. Notifications are delivered at COMMIT
 * time of the sender's transaction (or immediately if there's no
 * surrounding transaction); duplicate identical notifications inside
 * one transaction are coalesced by PG so listeners only see one.
 *
 * The channel name is a plain SQL identifier — quoted via
 * `quoteIdentifier`. The payload (when set) is a SQL string literal —
 * escaped via `escapeStringLiteral` before being spliced into the
 * `'…'` slot. PG enforces an 8 KB upper bound on the payload (the
 * `NOTIFY_PAYLOAD_LIMIT` server constant); we don't pre-check the size
 * because that limit is a build-time tunable and surfacing it here
 * would diverge from what the engine reports.
 *
 * Dialect support: **PG only.** Same `PUBSUB` feature gate as
 * {@link ListenNode}.
 */
export interface NotifyNode {
  type: "notify"
  channel: string
  /**
   * Optional `, '<payload>'` clause. When undefined PG sends a
   * notification with an empty payload; when set the string is
   * escaped via `escapeStringLiteral` at print time so single quotes
   * and backslashes survive verbatim through the SQL literal slot.
   */
  payload?: string
}

// ── Functions and triggers (PG, ADR 005, Phase 1) ──

/**
 * One argument in a `CREATE FUNCTION` parameter list. `mode` defaults
 * to `IN` when omitted; the printer skips emitting the keyword in that
 * case so the common shape `(price numeric)` stays free of noise.
 *
 * `defaultValue` is an `ExpressionNode` that flows through the DDL
 * expression printer — same identifier quoting and parameter binding
 * as a column DEFAULT.
 */
export interface FunctionArg {
  name: string
  type: string
  defaultValue?: ExpressionNode
  mode?: "IN" | "OUT" | "INOUT" | "VARIADIC"
}

/**
 * One variable in a `DECLARE` section.
 */
export interface PlpgsqlDeclaration {
  name: string
  dataType: string
  constant?: boolean
  notNull?: boolean
  initial?: ExpressionNode
}

/**
 * A statement inside a plpgsql body.
 *
 * Assignment, control flow and `RAISE` are the reason a function needs a
 * language at all — an expression body is a `SELECT` with extra steps. Each
 * variant maps to exactly one plpgsql construct so the printer never has to
 * infer what was meant.
 */
export type PlpgsqlStatement =
  | { type: "plpgsql_return"; value?: ExpressionNode }
  | { type: "plpgsql_return_next"; value: ExpressionNode }
  | { type: "plpgsql_return_query"; query: ASTNode }
  | { type: "plpgsql_assign"; target: string; value: ExpressionNode }
  | { type: "plpgsql_if"; branches: PlpgsqlBranch[]; otherwise?: PlpgsqlStatement[] }
  | { type: "plpgsql_while"; condition: ExpressionNode; body: PlpgsqlStatement[]; label?: string }
  | {
      type: "plpgsql_for_range"
      variable: string
      from: ExpressionNode
      to: ExpressionNode
      by?: ExpressionNode
      reverse?: boolean
      body: PlpgsqlStatement[]
      label?: string
    }
  | {
      type: "plpgsql_for_query"
      variable: string
      query: ASTNode
      body: PlpgsqlStatement[]
      label?: string
    }
  | { type: "plpgsql_loop"; body: PlpgsqlStatement[]; label?: string }
  | { type: "plpgsql_exit"; label?: string; when?: ExpressionNode }
  | { type: "plpgsql_continue"; label?: string; when?: ExpressionNode }
  | {
      type: "plpgsql_raise"
      level: PlpgsqlRaiseLevel
      message: string
      using?: PlpgsqlRaiseOption[]
    }
  | { type: "plpgsql_perform"; query: ASTNode }
  | { type: "plpgsql_statement"; query: ASTNode }
  | { type: "plpgsql_block"; block: StatementBlockNode }
  | { type: "plpgsql_null" }

export interface PlpgsqlBranch {
  condition: ExpressionNode
  body: PlpgsqlStatement[]
}

export type PlpgsqlRaiseLevel = "debug" | "log" | "info" | "notice" | "warning" | "exception"

export interface PlpgsqlRaiseOption {
  option: "MESSAGE" | "DETAIL" | "HINT" | "ERRCODE" | "COLUMN" | "CONSTRAINT" | "TABLE" | "SCHEMA"
  value: ExpressionNode
}

/**
 * A `DECLARE … BEGIN … END` body.
 */
export interface StatementBlockNode {
  type: "statement_block"
  declarations?: PlpgsqlDeclaration[]
  statements: PlpgsqlStatement[]
  label?: string
}

export function isStatementBlock(
  node: ExpressionNode | StatementBlockNode,
): node is StatementBlockNode {
  return (node as StatementBlockNode).type === "statement_block"
}

/**
 * `CREATE FUNCTION` (PostgreSQL).
 *
 * The `body` is either a single expression — `LANGUAGE sql` or a plpgsql
 * `RETURN` — or a full statement block.
 */
export interface CreateFunctionNode {
  type: "create_function"
  name: string
  schema?: string
  orReplace?: boolean
  args: FunctionArg[]
  returns: string
  language: "sql" | "plpgsql"
  body: ExpressionNode | StatementBlockNode
  immutable?: boolean
  stable?: boolean
  strict?: boolean
  parallel?: "safe" | "restricted" | "unsafe"
  security?: "definer" | "invoker"
}

export interface DropFunctionNode {
  type: "drop_function"
  name: string
  schema?: string
  argTypes?: string[]
  ifExists?: boolean
  cascade?: boolean
}

export interface CreateTriggerNode {
  type: "create_trigger"
  name: string
  table: string
  schema?: string
  timing: "BEFORE" | "AFTER" | "INSTEAD OF"
  events: ("INSERT" | "UPDATE" | "DELETE" | "TRUNCATE")[]
  updateOf?: string[]
  forEach: "ROW" | "STATEMENT"
  when?: ExpressionNode
  functionName: string
  functionSchema?: string
  functionArgs?: ExpressionNode[]
  orReplace?: boolean
  constraint?: { deferrable?: boolean; initiallyDeferred?: boolean }
}

export interface DropTriggerNode {
  type: "drop_trigger"
  name: string
  table: string
  schema?: string
  ifExists?: boolean
  cascade?: boolean
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
  | CreateSequenceNode
  | DropSequenceNode
  | AlterSequenceNode
  | VacuumNode
  | AnalyzeNode
  | ReindexNode
  | CreatePolicyNode
  | DropPolicyNode
  | AlterPolicyNode
  | CreateExtensionNode
  | DropExtensionNode
  | CreateTypeEnumNode
  | DropTypeNode
  | CreateDomainNode
  | DropDomainNode
  | AlterTypeAddValueNode
  | AlterTypeRenameNode
  | AlterTypeRenameValueNode
  | LockTableNode
  | CopyNode
  | ListenNode
  | UnlistenNode
  | NotifyNode
  | CreateFunctionNode
  | DropFunctionNode
  | CreateTriggerNode
  | DropTriggerNode
