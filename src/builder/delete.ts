import type {
  CTENode,
  DeleteNode,
  ExpressionNode,
  JoinNode,
  QueryFlags as QueryFlagsType,
  SelectNode,
  TableRefNode,
} from "../ast/nodes.ts"
import { createDeleteNode } from "../ast/nodes.ts"
import type { JoinType } from "../types.ts"
import { parseTableRef } from "../utils/table-ref.ts"

export class DeleteBuilder {
  private node: DeleteNode

  constructor(node?: DeleteNode) {
    this.node = node ?? createDeleteNode({ type: "table_ref", name: "" })
  }

  /** Merge a QueryFlags bitmap into the underlying node. */
  withFlags(flags: QueryFlagsType): DeleteBuilder {
    return new DeleteBuilder({ ...this.node, flags: (this.node.flags ?? 0) | flags })
  }

  from(table: string | TableRefNode): DeleteBuilder {
    const ref: TableRefNode = typeof table === "string" ? parseTableRef(table) : table
    return new DeleteBuilder({ ...this.node, table: ref })
  }

  where(expr: ExpressionNode): DeleteBuilder {
    if (this.node.where) {
      return new DeleteBuilder({
        ...this.node,
        where: { type: "binary_op", op: "AND", left: this.node.where, right: expr },
      })
    }
    return new DeleteBuilder({ ...this.node, where: expr })
  }

  orWhere(expr: ExpressionNode): DeleteBuilder {
    if (this.node.where) {
      return new DeleteBuilder({
        ...this.node,
        where: { type: "binary_op", op: "OR", left: this.node.where, right: expr },
      })
    }
    return new DeleteBuilder({ ...this.node, where: expr })
  }

  /** USING clause (PG: DELETE FROM t USING other WHERE ...) */
  using(table: string | TableRefNode): DeleteBuilder {
    const ref: TableRefNode = typeof table === "string" ? { type: "table_ref", name: table } : table
    return new DeleteBuilder({ ...this.node, using: ref })
  }

  /** Generic JOIN (MySQL pattern: DELETE t FROM t JOIN other ON ...) */
  join(type: JoinType, table: string | TableRefNode, on?: ExpressionNode): DeleteBuilder {
    const tableRef: TableRefNode =
      typeof table === "string" ? { type: "table_ref", name: table } : table
    const join: JoinNode = { type: "join", joinType: type, table: tableRef, on }
    return new DeleteBuilder({ ...this.node, joins: [...this.node.joins, join] })
  }

  innerJoin(table: string | TableRefNode, on: ExpressionNode): DeleteBuilder {
    return this.join("INNER", table, on)
  }

  leftJoin(table: string | TableRefNode, on: ExpressionNode): DeleteBuilder {
    return this.join("LEFT", table, on)
  }

  orderBy(expr: string | ExpressionNode, direction: "ASC" | "DESC" = "ASC"): DeleteBuilder {
    if (typeof expr === "string" && /\s/.test(expr)) {
      throw new Error(
        `orderBy(${JSON.stringify(expr)}) — column names may not contain spaces. ` +
          "Pass the direction as the second argument.",
      )
    }
    const node: import("../ast/nodes.ts").OrderByNode = {
      expr: typeof expr === "string" ? { type: "column_ref", column: expr } : expr,
      direction,
    }
    return new DeleteBuilder({
      ...this.node,
      orderBy: [...(this.node.orderBy ?? []), node],
    })
  }

  limit(n: ExpressionNode): DeleteBuilder {
    return new DeleteBuilder({ ...this.node, limit: n })
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
