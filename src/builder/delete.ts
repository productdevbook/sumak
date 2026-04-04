import type { CTENode, DeleteNode, ExpressionNode, SelectNode, TableRefNode } from "../ast/nodes.ts"
import { createDeleteNode } from "../ast/nodes.ts"

export class DeleteBuilder {
  private node: DeleteNode

  constructor(node?: DeleteNode) {
    this.node = node ?? createDeleteNode({ type: "table_ref", name: "" })
  }

  from(table: string | TableRefNode): DeleteBuilder {
    const ref: TableRefNode = typeof table === "string" ? { type: "table_ref", name: table } : table
    return new DeleteBuilder({ ...this.node, table: ref })
  }

  where(expr: ExpressionNode): DeleteBuilder {
    return new DeleteBuilder({ ...this.node, where: expr })
  }

  returning(...exprs: ExpressionNode[]): DeleteBuilder {
    return new DeleteBuilder({
      ...this.node,
      returning: [...this.node.returning, ...exprs],
    })
  }

  with(name: string, query: SelectNode, recursive = false): DeleteBuilder {
    const cte: CTENode = { name, query, recursive }
    return new DeleteBuilder({
      ...this.node,
      ctes: [...this.node.ctes, cte],
    })
  }

  build(): DeleteNode {
    return { ...this.node }
  }
}

export function deleteFrom(table: string | TableRefNode): DeleteBuilder {
  return new DeleteBuilder().from(table)
}
