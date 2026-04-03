import type {
  BetweenNode,
  BinaryOpNode,
  CastNode,
  ColumnRefNode,
  ExistsNode,
  ExpressionNode,
  FunctionCallNode,
  InNode,
  IsNullNode,
  LiteralNode,
  ParamNode,
  RawNode,
  SelectNode,
  StarNode,
  SubqueryNode,
  UnaryOpNode,
} from "./nodes.ts";

export function col(column: string, table?: string): ColumnRefNode {
  return { type: "column_ref", column, table };
}

export function colAs(column: string, alias: string, table?: string): ColumnRefNode {
  return { type: "column_ref", column, table, alias };
}

export function lit(value: string | number | boolean | null): LiteralNode {
  return { type: "literal", value };
}

export function star(table?: string): StarNode {
  return { type: "star", table };
}

export function param(index: number, value: unknown): ParamNode {
  return { type: "param", index, value };
}

export function raw(sql: string, params: unknown[] = []): RawNode {
  return { type: "raw", sql, params };
}

export function subquery(query: SelectNode, alias?: string): SubqueryNode {
  return { type: "subquery", query, alias };
}

export function fn(name: string, args: ExpressionNode[], alias?: string): FunctionCallNode {
  return { type: "function_call", name, args, alias };
}

export function binOp(op: string, left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return { type: "binary_op", op, left, right };
}

export function unaryOp(
  op: string,
  operand: ExpressionNode,
  position: "prefix" | "postfix" = "prefix",
): UnaryOpNode {
  return { type: "unary_op", op, operand, position };
}

export function and(left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return binOp("AND", left, right);
}

export function or(left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return binOp("OR", left, right);
}

export function eq(left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return binOp("=", left, right);
}

export function neq(left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return binOp("!=", left, right);
}

export function gt(left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return binOp(">", left, right);
}

export function gte(left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return binOp(">=", left, right);
}

export function lt(left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return binOp("<", left, right);
}

export function lte(left: ExpressionNode, right: ExpressionNode): BinaryOpNode {
  return binOp("<=", left, right);
}

export function like(expr: ExpressionNode, pattern: ExpressionNode): BinaryOpNode {
  return binOp("LIKE", expr, pattern);
}

export function between(
  expr: ExpressionNode,
  low: ExpressionNode,
  high: ExpressionNode,
  negated = false,
): BetweenNode {
  return { type: "between", expr, low, high, negated };
}

export function inList(
  expr: ExpressionNode,
  values: ExpressionNode[] | SelectNode,
  negated = false,
): InNode {
  return { type: "in", expr, values, negated };
}

export function isNull(expr: ExpressionNode, negated = false): IsNullNode {
  return { type: "is_null", expr, negated };
}

export function cast(expr: ExpressionNode, dataType: string): CastNode {
  return { type: "cast", expr, dataType };
}

export function exists(query: SelectNode, negated = false): ExistsNode {
  return { type: "exists", query, negated };
}

export function not(operand: ExpressionNode): UnaryOpNode {
  return unaryOp("NOT", operand);
}
