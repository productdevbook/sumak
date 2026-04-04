import type { JoinType, OrderDirection, SetOperator } from "../types.ts"

export type ASTNode = SelectNode | InsertNode | UpdateNode | DeleteNode | MergeNode | ExpressionNode

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
}

export interface SelectNode {
  type: "select"
  distinct: boolean
  distinctOn?: ExpressionNode[]
  columns: ExpressionNode[]
  from?: TableRefNode | SubqueryNode
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
}

export interface OnConflictNode {
  columns: string[]
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
}

export interface DeleteNode {
  type: "delete"
  table: TableRefNode
  where?: ExpressionNode
  returning: ExpressionNode[]
  ctes: CTENode[]
  using?: TableRefNode
  joins: JoinNode[]
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
