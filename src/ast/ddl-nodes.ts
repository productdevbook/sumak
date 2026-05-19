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
  | CreateExtensionNode
  | DropExtensionNode
  | LockTableNode
