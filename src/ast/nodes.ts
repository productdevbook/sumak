import type { JoinType, OrderDirection, SetOperator } from "../types.ts"

export type ASTNode =
  | SelectNode
  | InsertNode
  | UpdateNode
  | DeleteNode
  | MergeNode
  | ExplainNode
  | ExpressionNode

export interface ExplainNode {
  type: "explain"
  statement: SelectNode | InsertNode | UpdateNode | DeleteNode
  analyze?: boolean
  /**
   * Plan-output format. Dialect support varies:
   *  - pg: TEXT, JSON, YAML, XML
   *  - mysql: TRADITIONAL (=TEXT), JSON, TREE; only TREE allowed with ANALYZE
   *  - sqlite/mssql: not supported (printer throws)
   */
  format?: "TEXT" | "JSON" | "YAML" | "XML" | "TREE" | "TRADITIONAL"
}

export type ExpressionNode =
  | ColumnRefNode
  | LiteralNode
  | BinaryOpNode
  | UnaryOpNode
  | FunctionCallNode
  | ParamNode
  | RawNode
  | SubqueryNode
  | BetweenNode
  | InNode
  | IsNullNode
  | IsJsonNode
  | CaseNode
  | CastNode
  | ExistsNode
  | StarNode
  | JsonAccessNode
  | ArrayExprNode
  | WindowFunctionNode
  | AliasedExprNode
  | FullTextSearchNode
  | TupleNode
  | QuantifiedExprNode
  | GroupingExprNode

export interface ColumnRefNode {
  type: "column_ref"
  table?: string
  column: string
  alias?: string
}

export interface LiteralNode {
  type: "literal"
  value: string | number | boolean | null
}

export interface BinaryOpNode {
  type: "binary_op"
  op: string
  left: ExpressionNode
  right: ExpressionNode
}

export interface UnaryOpNode {
  type: "unary_op"
  op: string
  operand: ExpressionNode
  position: "prefix" | "postfix"
}

export interface FunctionCallNode {
  type: "function_call"
  name: string
  args: ExpressionNode[]
  distinct?: boolean
  filter?: ExpressionNode
  /**
   * Inline ORDER BY inside the argument list — `STRING_AGG(expr, sep
   * ORDER BY x)`. Different clause from {@link withinGroup}; both can
   * appear simultaneously though it's semantically unusual.
   */
  orderBy?: OrderByNode[]
  /**
   * SQL standard ordered-set aggregate clause:
   * `FN(args) WITHIN GROUP (ORDER BY …)`. Used by `PERCENTILE_CONT`,
   * `PERCENTILE_DISC`, `MODE`, and other inverse-distribution
   * aggregates. Structurally separate from `orderBy` (inside the arg
   * list) — both clauses can attach to the same call.
   */
  withinGroup?: OrderByNode[]
  /**
   * SQL:2016 JSON-function `RETURNING <type>` clause —
   * `JSON_VALUE(json, '$.path' RETURNING int)`. Specific to
   * `JSON_VALUE` (and prospective `JSON_QUERY`) callsites; other
   * function names ignore this slot at print time. The value is the
   * raw SQL type name; it flows through {@link validateDataType} in
   * the printer before being emitted, so callers can't inject via
   * this field.
   *
   * Dialect support: PG 17+ and MySQL 8 accept the clause; MSSQL's
   * `JSON_VALUE` always returns nvarchar(4000) and the printer rejects
   * a non-empty `returningType` on that dialect — wrap with `CAST(...)`.
   */
  returningType?: string
  alias?: string
}

export interface ParamNode {
  type: "param"
  index: number
  value: unknown
}

export interface RawNode {
  type: "raw"
  sql: string
  params: unknown[]
}

export interface SubqueryNode {
  type: "subquery"
  query: SelectNode
  alias?: string
}

export interface BetweenNode {
  type: "between"
  expr: ExpressionNode
  low: ExpressionNode
  high: ExpressionNode
  negated: boolean
  symmetric?: boolean
}

export interface InNode {
  type: "in"
  expr: ExpressionNode
  values: ExpressionNode[] | SelectNode
  negated: boolean
}

export interface IsNullNode {
  type: "is_null"
  expr: ExpressionNode
  negated: boolean
}

/**
 * `expr IS [NOT] JSON [VALUE | SCALAR | ARRAY | OBJECT]` — SQL:2016
 * predicate that tests whether a string-or-JSON expression is valid
 * JSON, optionally constraining the JSON kind. `kind` undefined emits
 * the bare `IS JSON` form (any JSON value).
 *
 * Dialect-gated: PG 16+, MySQL 8+, MSSQL all support every variant.
 * SQLite has no equivalent and the SQLite printer refuses.
 */
export interface IsJsonNode {
  type: "is_json"
  expr: ExpressionNode
  /** Omit for bare `IS JSON`. */
  kind?: "value" | "scalar" | "array" | "object"
  negated: boolean
}

export interface CaseNode {
  type: "case"
  operand?: ExpressionNode
  whens: { condition: ExpressionNode; result: ExpressionNode }[]
  else_?: ExpressionNode
}

/** Allowed SQL data types for CAST — prevents injection via arbitrary dataType strings. */
export type SqlDataType =
  | "TEXT"
  | "VARCHAR"
  | "CHAR"
  | "INTEGER"
  | "INT"
  | "SMALLINT"
  | "BIGINT"
  | "SERIAL"
  | "BIGSERIAL"
  | "REAL"
  | "FLOAT"
  | "DOUBLE PRECISION"
  | "NUMERIC"
  | "DECIMAL"
  | "BOOLEAN"
  | "DATE"
  | "TIME"
  | "TIMESTAMP"
  | "TIMESTAMPTZ"
  | "TIMESTAMP WITH TIME ZONE"
  | "INTERVAL"
  | "UUID"
  | "JSON"
  | "JSONB"
  | "BYTEA"
  | "BLOB"
  | "CLOB"
  | "XML"
  | "MONEY"
  | "INET"
  | "CIDR"
  | "MACADDR"
  | "BIT"
  | "VARBIT"
  | "POINT"
  | "LINE"
  | "LSEG"
  | "BOX"
  | "PATH"
  | "POLYGON"
  | "CIRCLE"
  | "TSVECTOR"
  | "TSQUERY"
  | "REGCLASS"
  | "OID"
  | "ARRAY"
  | (string & {})

export interface CastNode {
  type: "cast"
  expr: ExpressionNode
  dataType: string
}

export interface ExistsNode {
  type: "exists"
  query: SelectNode
  negated: boolean
}

export interface StarNode {
  type: "star"
  table?: string
}

export type FullTextSearchMode = "natural" | "boolean" | "expansion"

export interface FullTextSearchNode {
  type: "full_text_search"
  columns: ExpressionNode[]
  query: ExpressionNode
  mode?: FullTextSearchMode
  language?: string
  alias?: string
}

export interface TupleNode {
  type: "tuple"
  elements: ExpressionNode[]
}

/**
 * Inline `VALUES (...), (...)` clause used as a derived table in
 * FROM: `FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, name)`. Rows
 * are tuples of expressions; all rows must have the same arity
 * (builder enforces). `alias` + `columnAliases` name the derived
 * table and its columns — required on every dialect we support.
 */
export interface ValuesClauseNode {
  type: "values_clause"
  /** Each row is a tuple of expressions; the row count must be ≥ 1. */
  rows: ExpressionNode[][]
  alias: string
  columnAliases: string[]
}

/**
 * `GROUPING SETS ((a, b), (a), ())` / `CUBE(a, b)` / `ROLLUP(a, b)` —
 * multi-dimensional grouping extensions to GROUP BY. Stored as a
 * special expression node so the `SelectNode.groupBy` slot can hold
 * a mix of regular column expressions and these grouping constructs.
 * Each entry in the `sets` field is a "group" (a list of columns
 * evaluated together). An empty group means "one total row" — legal
 * inside GROUPING SETS, not meaningful for CUBE/ROLLUP.
 *
 * Feature-matrix gated: PG / MSSQL support all three; SQLite has
 * `ROLLUP` and `CUBE` (3.46+) but not `GROUPING SETS`; MySQL has
 * `WITH ROLLUP` on GROUP BY with a syntactic twist — we reject
 * GROUPING SETS / CUBE on MySQL and render ROLLUP via a printer
 * override to the `GROUP BY ... WITH ROLLUP` form.
 */
export interface GroupingExprNode {
  type: "grouping"
  kind: "grouping_sets" | "cube" | "rollup"
  sets: ExpressionNode[][]
}

/**
 * Quantified subquery / array comparison — `col <op> ANY(...)` or
 * `col <op> ALL(...)`. The operand is either a subquery (`ANY (SELECT
 * ... FROM ...)`) or an array expression (`ANY (ARRAY[1,2,3])` /
 * `ANY ($1)` where $1 is bound to a driver array). Supported on PG
 * and, for array operand, on MySQL 8+; MSSQL / SQLite reject it at
 * compile time via the feature matrix.
 */
export interface QuantifiedExprNode {
  type: "quantified"
  quantifier: "ANY" | "ALL" | "SOME"
  operand: SubqueryNode | ArrayExprNode | ParamNode | RawNode | LiteralNode
}

export interface AliasedExprNode {
  type: "aliased_expr"
  expr: ExpressionNode
  alias: string
}

export type TemporalClause =
  | { kind: "as_of"; timestamp: ExpressionNode }
  | { kind: "from_to"; start: ExpressionNode; end: ExpressionNode }
  | { kind: "between"; start: ExpressionNode; end: ExpressionNode }
  | { kind: "contained_in"; start: ExpressionNode; end: ExpressionNode }
  | { kind: "all" }

export interface TableRefNode {
  type: "table_ref"
  name: string
  alias?: string
  schema?: string
  temporal?: TemporalClause
}

export interface JoinNode {
  type: "join"
  joinType: JoinType
  table: TableRefNode | SubqueryNode | ValuesClauseNode
  on?: ExpressionNode
  lateral?: boolean
}

export interface JsonAccessNode {
  type: "json_access"
  expr: ExpressionNode
  path: string
  operator: "->" | "->>" | "#>" | "#>>"
  alias?: string
}

export interface ArrayExprNode {
  type: "array_expr"
  elements: ExpressionNode[]
}

export type FrameKind = "ROWS" | "RANGE" | "GROUPS"
export type FrameBound =
  | { type: "unbounded_preceding" }
  | { type: "preceding"; value: number }
  | { type: "current_row" }
  | { type: "following"; value: number }
  | { type: "unbounded_following" }

/**
 * Optional SQL:2011 `EXCLUDE` clause that trims rows out of an
 * already-computed frame. Applies *after* the start/end bounds pick
 * a candidate window of rows.
 *
 * - `"no_others"` — keep everything (the implicit default; emitted
 *   explicitly only if the user asks for it).
 * - `"current_row"` — drop the current row from the frame.
 * - `"group"` — drop the current row **and** its peers (rows with the
 *   same `ORDER BY` keys).
 * - `"ties"` — drop the peers but keep the current row.
 *
 * Supported on PG and SQLite. MySQL 8 and MSSQL have no frame-exclude
 * grammar — their printers throw via the `FRAME_EXCLUDE` feature flag.
 */
export type FrameExclude = "no_others" | "current_row" | "group" | "ties"

export interface FrameSpec {
  kind: FrameKind
  start: FrameBound
  end?: FrameBound
  exclude?: FrameExclude
}

/**
 * `<window-fn>() OVER (...)` or `<window-fn>() OVER name`.
 *
 * Two shapes share this node — discriminated by `windowName`:
 *
 *  - **Inline window**: `partitionBy` / `orderBy` / `frame` describe the
 *    spec right there. `windowName` is undefined.
 *  - **Named-window reference**: `windowName` points at a definition
 *    registered on the surrounding `SelectNode.windows`. The printer
 *    emits `OVER <name>` and ignores the inline `partitionBy` /
 *    `orderBy` / `frame` slots (which builders leave empty for this
 *    case). The named entry on the SelectNode carries the actual spec
 *    so downstream traversal sees a single source of truth.
 *
 * Picking option A (reuse this node) over a separate `WindowRefNode`
 * keeps every AST consumer — visitor, walker, transformer, every
 * dialect printer — on one switch case. Adding a sibling node would
 * have meant touching ~6 more exhaustive switches purely to route the
 * same downstream emit.
 */
export interface WindowFunctionNode {
  type: "window_function"
  fn: FunctionCallNode
  partitionBy: ExpressionNode[]
  orderBy: OrderByNode[]
  frame?: FrameSpec
  alias?: string
  /**
   * When set, this window-function call references a named window
   * registered on the surrounding SELECT's `windows` slot. The printer
   * emits `OVER <windowName>` and treats `partitionBy` / `orderBy` /
   * `frame` as empty regardless of their content.
   */
  windowName?: string
}

/**
 * A `WINDOW w AS (PARTITION BY x ORDER BY y)` clause entry. Lives on
 * `SelectNode.windows` and is referenced by `WindowFunctionNode` calls
 * via the `windowName` discriminator.
 *
 * `baseName` carries SQL:2003 window-inheritance: `WINDOW w2 AS (w
 * ORDER BY y)` parses as "start from `w`, then add ORDER BY y". The
 * spec restricts what the inheriting window may override — the
 * derived window must not redeclare `PARTITION BY` and (if `w`
 * already has `ORDER BY`) must not redeclare `ORDER BY` — but the AST
 * stores the literal user intent and the printer copies the layers
 * verbatim. Dialects that disagree (none of pg/mysql/sqlite reject
 * the well-formed cases we surface) are guarded at the builder layer.
 */
export interface NamedWindow {
  name: string
  partitionBy: ExpressionNode[]
  orderBy: OrderByNode[]
  frame?: FrameSpec
  baseName?: string
}

export interface OrderByNode {
  expr: ExpressionNode
  direction: OrderDirection
  nulls?: "FIRST" | "LAST"
}

export interface CTENode {
  name: string
  query: SelectNode
  recursive: boolean
}

export interface WindowNode {
  partitionBy: ExpressionNode[]
  orderBy: OrderByNode[]
}

export type LockMode = "UPDATE" | "SHARE" | "NO KEY UPDATE" | "KEY SHARE"

export interface LockClause {
  mode: LockMode
  skipLocked?: boolean
  noWait?: boolean
  /**
   * Tables to lock (PostgreSQL `FOR UPDATE OF t1, t2`). When unset, the
   * lock applies to every row that would be returned — standard behavior.
   * Used to avoid deadlocks in multi-table joins where only one side
   * actually needs row-level locking.
   */
  of?: string[]
}

/**
 * Bitmap flags attached to SELECT/UPDATE/DELETE nodes to carry builder
 * intent through plugin transforms. Inspired by TypeScript-Go's `NodeFlags`:
 * a single integer lets plugins signal state (idempotency tokens).
 *
 * For mutually-exclusive modes (e.g. soft-delete filter mode), use the
 * dedicated field on the node (e.g. `softDeleteMode`) instead of flags —
 * those are tri-state, not bits.
 *
 * Treat as internal — sumak builders set and read these; user code
 * generally shouldn't.
 */
export const QueryFlags = {
  None: 0,
  /** Plugin has already injected its soft-delete filter — don't double-apply. */
  SoftDeleteApplied: 1,
  /** Plugin has already injected its multi-tenant filter — don't double-apply. */
  MultiTenantApplied: 2,
  /** Plugin has already injected its optimistic-lock predicate + SET. */
  OptimisticLockApplied: 4,
  /**
   * Builder called `.crossTenant({ reason })` to opt this query out of
   * multiTenant({ strict: true })'s JOIN allow-list check. The flag
   * records caller intent; audit/observability hooks see
   * `QueryFlags.CrossTenantOptOut` on the AST so cross-tenant traffic
   * is tracked even when allowed.
   */
  CrossTenantOptOut: 8,
  /**
   * The {@link caslAuthz} plugin already injected its CASL-derived
   * WHERE into this node. Guards against double-application when the
   * PluginManager recurses into inner SELECTs (CTEs, subqueries) and
   * re-runs the chain — without this flag, nested SELECTs over the
   * same table would accumulate `AND casl_where` on every pass.
   */
  CaslAuthzApplied: 16,
} as const
export type QueryFlags = number

/**
 * Soft-delete filter mode carried on SELECT/UPDATE nodes. Tri-state: only
 * one mode is ever active per query, so an enum is safer than two flag
 * bits that could be set simultaneously.
 *
 * - `"exclude"` (default, unset) — standard filter: `WHERE deleted_at IS NULL`.
 * - `"include"` — bypass the filter entirely (`.includeDeleted()`).
 * - `"only"`    — invert the filter (`.onlyDeleted()`): only deleted rows.
 */
export type SoftDeleteMode = "include" | "only"

export interface SelectNode {
  type: "select"
  distinct: boolean
  distinctOn?: ExpressionNode[]
  columns: ExpressionNode[]
  from?: TableRefNode | SubqueryNode | ValuesClauseNode | import("./graph-nodes.ts").GraphTableNode
  joins: JoinNode[]
  where?: ExpressionNode
  groupBy: ExpressionNode[]
  having?: ExpressionNode
  orderBy: OrderByNode[]
  limit?: ExpressionNode
  offset?: ExpressionNode
  ctes: CTENode[]
  setOp?: { op: SetOperator; query: SelectNode }
  lock?: LockClause
  /**
   * `WINDOW w AS (...), w2 AS (w ORDER BY ...)` clause — SQL:2003 named
   * window definitions referenced by `WindowFunctionNode.windowName`.
   * The printer emits this list between ORDER BY and LIMIT per the
   * PG/MySQL/SQLite grammar; MSSQL doesn't support the clause so the
   * MSSQL printer throws when it sees a non-empty `windows`.
   */
  windows?: NamedWindow[]
  /** @see QueryFlags */
  flags?: QueryFlags
  /** User-specified soft-delete filter mode. Unset = normal filter. */
  softDeleteMode?: SoftDeleteMode
}

export type InsertMode =
  | "INSERT"
  | "INSERT OR IGNORE"
  | "INSERT OR REPLACE"
  | "INSERT OR ABORT"
  | "INSERT OR ROLLBACK"
  | "INSERT OR FAIL"

export interface InsertNode {
  type: "insert"
  insertMode?: InsertMode
  table: TableRefNode
  columns: string[]
  values: ExpressionNode[][]
  returning: ExpressionNode[]
  onConflict?: OnConflictNode
  onDuplicateKeyUpdate?: { column: string; value: ExpressionNode }[]
  ctes: CTENode[]
  source?: SelectNode
  defaultValues?: boolean
  /**
   * SQL:2003 `OVERRIDING { SYSTEM | USER } VALUE` clause. Sits between
   * the column list and `VALUES` / `SELECT`. `"SYSTEM"` lets an INSERT
   * provide a value for a column declared `GENERATED ALWAYS AS IDENTITY`
   * (which normally rejects user-supplied values); `"USER"` forces the
   * system value even if the user supplied one for a `GENERATED BY
   * DEFAULT AS IDENTITY` column. PG-only — MySQL/SQLite have no
   * identity-column-overriding grammar (their auto-increment columns
   * accept user values directly); MSSQL has the separate `SET
   * IDENTITY_INSERT` statement. Guarded by the `INSERT_OVERRIDING`
   * feature flag.
   */
  overriding?: "SYSTEM" | "USER"
  /** @see QueryFlags */
  flags?: QueryFlags
}

export interface OnConflictNode {
  columns: string[]
  constraint?: string
  action: "nothing" | { set: { column: string; value: ExpressionNode }[] }
  where?: ExpressionNode
}

export interface UpdateNode {
  type: "update"
  table: TableRefNode
  set: { column: string; value: ExpressionNode }[]
  where?: ExpressionNode
  returning: ExpressionNode[]
  from?: TableRefNode
  joins: JoinNode[]
  ctes: CTENode[]
  orderBy?: OrderByNode[]
  limit?: ExpressionNode
  /** @see QueryFlags */
  flags?: QueryFlags
  /** User-specified soft-delete filter mode. Unset = normal filter. */
  softDeleteMode?: SoftDeleteMode
}

export interface DeleteNode {
  type: "delete"
  table: TableRefNode
  where?: ExpressionNode
  returning: ExpressionNode[]
  ctes: CTENode[]
  using?: TableRefNode
  joins: JoinNode[]
  orderBy?: OrderByNode[]
  limit?: ExpressionNode
  /** @see QueryFlags */
  flags?: QueryFlags
}

export interface MergeWhenMatched {
  type: "matched"
  condition?: ExpressionNode
  action: "update" | "delete"
  set?: { column: string; value: ExpressionNode }[]
}

export interface MergeWhenNotMatched {
  type: "not_matched"
  condition?: ExpressionNode
  columns: string[]
  values: ExpressionNode[]
}

/**
 * `WHEN NOT MATCHED BY SOURCE` — fires for target rows with no source match.
 *
 * Shape mirrors {@link MergeWhenMatched}: the row already exists in the
 * target, so the only meaningful actions are UPDATE or DELETE (an INSERT
 * makes no sense — there's nothing to insert *from*). Supported natively
 * by PostgreSQL 17+ and MSSQL; rejected by MySQL/SQLite at the dialect
 * layer since neither implements ANSI MERGE.
 */
export interface MergeWhenNotMatchedBySource {
  type: "not_matched_by_source"
  condition?: ExpressionNode
  action: "update" | "delete"
  set?: { column: string; value: ExpressionNode }[]
}

export interface MergeNode {
  type: "merge"
  target: TableRefNode
  source: TableRefNode | SubqueryNode
  sourceAlias: string
  on: ExpressionNode
  whens: (MergeWhenMatched | MergeWhenNotMatched | MergeWhenNotMatchedBySource)[]
  /**
   * SQL:2023 `RETURNING` projection on MERGE. PG 17+ accepts it
   * natively, including the PG-only `merge_action()` projection that
   * returns the branch that fired (`'INSERT' | 'UPDATE' | 'DELETE'`).
   * MSSQL has its own `OUTPUT` clause with different syntax — surface
   * it as a follow-up; until then the MSSQL printer throws when this
   * slot is non-empty. MySQL/SQLite have no `MERGE`, so the question
   * doesn't arise.
   */
  returning: ExpressionNode[]
  ctes: CTENode[]
  /** @see QueryFlags — used by soft-delete plugin for idempotency. */
  flags?: QueryFlags
}

export function createMergeNode(
  target: TableRefNode,
  source: TableRefNode | SubqueryNode,
  sourceAlias: string,
  on: ExpressionNode,
): MergeNode {
  return {
    type: "merge",
    target,
    source,
    sourceAlias,
    on,
    whens: [],
    returning: [],
    ctes: [],
  }
}

export function tableRef(name: string, alias?: string, schema?: string): TableRefNode {
  return Object.freeze({ type: "table_ref" as const, name, alias, schema })
}

export function createSelectNode(): SelectNode {
  return {
    type: "select",
    distinct: false,
    columns: [],
    joins: [],
    groupBy: [],
    orderBy: [],
    ctes: [],
  }
}

export function createInsertNode(table: TableRefNode): InsertNode {
  return {
    type: "insert",
    table,
    columns: [],
    values: [],
    returning: [],
    ctes: [],
  }
}

export function createUpdateNode(table: TableRefNode): UpdateNode {
  return {
    type: "update",
    table,
    set: [],
    returning: [],
    joins: [],
    ctes: [],
  }
}

export function createDeleteNode(table: TableRefNode): DeleteNode {
  return {
    type: "delete",
    table,
    returning: [],
    ctes: [],
    joins: [],
  }
}
