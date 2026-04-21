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
  orderBy?: OrderByNode[]
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
  table: TableRefNode | SubqueryNode
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

export interface FrameSpec {
  kind: FrameKind
  start: FrameBound
  end?: FrameBound
}

export interface WindowFunctionNode {
  type: "window_function"
  fn: FunctionCallNode
  partitionBy: ExpressionNode[]
  orderBy: OrderByNode[]
  frame?: FrameSpec
  alias?: string
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
  SoftDeleteApplied: 1 << 0,
  /** Plugin has already injected its multi-tenant filter — don't double-apply. */
  MultiTenantApplied: 1 << 1,
  /** Plugin has already injected its optimistic-lock predicate + SET. */
  OptimisticLockApplied: 1 << 2,
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
  from?: TableRefNode | SubqueryNode | import("./graph-nodes.ts").GraphTableNode
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

export interface MergeNode {
  type: "merge"
  target: TableRefNode
  source: TableRefNode | SubqueryNode
  sourceAlias: string
  on: ExpressionNode
  whens: (MergeWhenMatched | MergeWhenNotMatched)[]
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
