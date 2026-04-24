import { assertNever } from "../errors.ts"
import type {
  ASTNode,
  CTENode,
  DeleteNode,
  ExpressionNode,
  InsertNode,
  JoinNode,
  MergeNode,
  OrderByNode,
  SelectNode,
  UpdateNode,
} from "./nodes.ts"

export interface ASTVisitor<R = void> {
  visitSelect(node: SelectNode): R
  visitInsert(node: InsertNode): R
  visitUpdate(node: UpdateNode): R
  visitDelete(node: DeleteNode): R
  visitMerge(node: MergeNode): R
  visitExpression(node: ExpressionNode): R
  visitJoin(node: JoinNode): R
  visitOrderBy(node: OrderByNode): R
  visitCTE(node: CTENode): R
}

export function visitNode<R>(node: ASTNode, visitor: ASTVisitor<R>): R {
  switch (node.type) {
    case "select":
      return visitor.visitSelect(node)
    case "insert":
      return visitor.visitInsert(node)
    case "update":
      return visitor.visitUpdate(node)
    case "delete":
      return visitor.visitDelete(node)
    case "merge":
      return visitor.visitMerge(node)
    case "explain":
      return visitNode(node.statement, visitor)
    case "column_ref":
    case "literal":
    case "binary_op":
    case "unary_op":
    case "function_call":
    case "param":
    case "raw":
    case "subquery":
    case "between":
    case "in":
    case "is_null":
    case "case":
    case "cast":
    case "exists":
    case "star":
    case "json_access":
    case "array_expr":
    case "window_function":
    case "aliased_expr":
    case "full_text_search":
    case "tuple":
    case "quantified":
      return visitor.visitExpression(node)
    default:
      return assertNever(node, "visitNode")
  }
}
