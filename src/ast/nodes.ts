import type { JoinType, OrderDirection, SetOperator } from "../types.ts";

export type ASTNode = SelectNode | InsertNode | UpdateNode | DeleteNode | ExpressionNode;

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
  | StarNode;

export interface ColumnRefNode {
  type: "column_ref";
  table?: string;
  column: string;
  alias?: string;
}

export interface LiteralNode {
  type: "literal";
  value: string | number | boolean | null;
}

export interface BinaryOpNode {
  type: "binary_op";
  op: string;
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface UnaryOpNode {
  type: "unary_op";
  op: string;
  operand: ExpressionNode;
  position: "prefix" | "postfix";
}

export interface FunctionCallNode {
  type: "function_call";
  name: string;
  args: ExpressionNode[];
  alias?: string;
}

export interface ParamNode {
  type: "param";
  index: number;
  value: unknown;
}

export interface RawNode {
  type: "raw";
  sql: string;
  params: unknown[];
}

export interface SubqueryNode {
  type: "subquery";
  query: SelectNode;
  alias?: string;
}

export interface BetweenNode {
  type: "between";
  expr: ExpressionNode;
  low: ExpressionNode;
  high: ExpressionNode;
  negated: boolean;
}

export interface InNode {
  type: "in";
  expr: ExpressionNode;
  values: ExpressionNode[] | SelectNode;
  negated: boolean;
}

export interface IsNullNode {
  type: "is_null";
  expr: ExpressionNode;
  negated: boolean;
}

export interface CaseNode {
  type: "case";
  operand?: ExpressionNode;
  whens: { condition: ExpressionNode; result: ExpressionNode }[];
  else_?: ExpressionNode;
}

export interface CastNode {
  type: "cast";
  expr: ExpressionNode;
  dataType: string;
}

export interface ExistsNode {
  type: "exists";
  query: SelectNode;
  negated: boolean;
}

export interface StarNode {
  type: "star";
  table?: string;
}

export interface TableRefNode {
  name: string;
  alias?: string;
  schema?: string;
}

export interface JoinNode {
  joinType: JoinType;
  table: TableRefNode | SubqueryNode;
  on?: ExpressionNode;
}

export interface OrderByNode {
  expr: ExpressionNode;
  direction: OrderDirection;
  nulls?: "FIRST" | "LAST";
}

export interface CTENode {
  name: string;
  query: SelectNode;
  recursive: boolean;
}

export interface WindowNode {
  partitionBy: ExpressionNode[];
  orderBy: OrderByNode[];
}

export interface SelectNode {
  type: "select";
  distinct: boolean;
  columns: ExpressionNode[];
  from?: TableRefNode | SubqueryNode;
  joins: JoinNode[];
  where?: ExpressionNode;
  groupBy: ExpressionNode[];
  having?: ExpressionNode;
  orderBy: OrderByNode[];
  limit?: ExpressionNode;
  offset?: ExpressionNode;
  ctes: CTENode[];
  setOp?: { op: SetOperator; query: SelectNode };
  forUpdate: boolean;
}

export interface InsertNode {
  type: "insert";
  table: TableRefNode;
  columns: string[];
  values: ExpressionNode[][];
  returning: ExpressionNode[];
  onConflict?: OnConflictNode;
  ctes: CTENode[];
}

export interface OnConflictNode {
  columns: string[];
  action: "nothing" | { set: { column: string; value: ExpressionNode }[] };
  where?: ExpressionNode;
}

export interface UpdateNode {
  type: "update";
  table: TableRefNode;
  set: { column: string; value: ExpressionNode }[];
  where?: ExpressionNode;
  returning: ExpressionNode[];
  from?: TableRefNode;
  ctes: CTENode[];
}

export interface DeleteNode {
  type: "delete";
  table: TableRefNode;
  where?: ExpressionNode;
  returning: ExpressionNode[];
  ctes: CTENode[];
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
    forUpdate: false,
  };
}

export function createInsertNode(table: TableRefNode): InsertNode {
  return {
    type: "insert",
    table,
    columns: [],
    values: [],
    returning: [],
    ctes: [],
  };
}

export function createUpdateNode(table: TableRefNode): UpdateNode {
  return {
    type: "update",
    table,
    set: [],
    returning: [],
    ctes: [],
  };
}

export function createDeleteNode(table: TableRefNode): DeleteNode {
  return {
    type: "delete",
    table,
    returning: [],
    ctes: [],
  };
}
