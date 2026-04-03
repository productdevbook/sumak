import type {
  ASTNode,
  CTENode,
  DeleteNode,
  ExpressionNode,
  InsertNode,
  JoinNode,
  OrderByNode,
  SelectNode,
  UpdateNode,
} from "./nodes.ts";

export interface ASTVisitor<R = void> {
  visitSelect(node: SelectNode): R;
  visitInsert(node: InsertNode): R;
  visitUpdate(node: UpdateNode): R;
  visitDelete(node: DeleteNode): R;
  visitExpression(node: ExpressionNode): R;
  visitJoin(node: JoinNode): R;
  visitOrderBy(node: OrderByNode): R;
  visitCTE(node: CTENode): R;
}

export function visitNode<R>(node: ASTNode, visitor: ASTVisitor<R>): R {
  switch (node.type) {
    case "select":
      return visitor.visitSelect(node);
    case "insert":
      return visitor.visitInsert(node);
    case "update":
      return visitor.visitUpdate(node);
    case "delete":
      return visitor.visitDelete(node);
    default:
      return visitor.visitExpression(node);
  }
}
