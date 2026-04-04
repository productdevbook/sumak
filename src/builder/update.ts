import type {
  CTENode,
  ExpressionNode,
  JoinNode,
  SelectNode,
  TableRefNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { createUpdateNode } from "../ast/nodes.ts"
import type { JoinType } from "../types.ts"

export class UpdateBuilder {
  private node: UpdateNode

  constructor(node?: UpdateNode) {
    this.node = node ?? createUpdateNode({ type: "table_ref", name: "" })
  }

  table(table: string | TableRefNode): UpdateBuilder {
    const ref: TableRefNode = typeof table === "string" ? { type: "table_ref", name: table } : table
    return new UpdateBuilder({ ...this.node, table: ref })
  }

  set(column: string, value: ExpressionNode): UpdateBuilder {
    return new UpdateBuilder({
      ...this.node,
      set: [...this.node.set, { column, value }],
    })
  }

  where(expr: ExpressionNode): UpdateBuilder {
    if (this.node.where) {
      return new UpdateBuilder({
        ...this.node,
        where: { type: "binary_op", op: "AND", left: this.node.where, right: expr },
      })
    }
    return new UpdateBuilder({ ...this.node, where: expr })
  }

  from(table: string | TableRefNode): UpdateBuilder {
    const ref: TableRefNode = typeof table === "string" ? { type: "table_ref", name: table } : table
    return new UpdateBuilder({ ...this.node, from: ref })
  }

  /** Generic JOIN (MySQL pattern: UPDATE t JOIN other ON ... SET ...) */
  join(type: JoinType, table: string | TableRefNode, on?: ExpressionNode): UpdateBuilder {
    const tableRef: TableRefNode =
      typeof table === "string" ? { type: "table_ref", name: table } : table
    const join: JoinNode = { type: "join", joinType: type, table: tableRef, on }
    return new UpdateBuilder({ ...this.node, joins: [...this.node.joins, join] })
  }

  innerJoin(table: string | TableRefNode, on: ExpressionNode): UpdateBuilder {
    return this.join("INNER", table, on)
  }

  leftJoin(table: string | TableRefNode, on: ExpressionNode): UpdateBuilder {
    return this.join("LEFT", table, on)
  }

  orderBy(expr: string | ExpressionNode, direction: "ASC" | "DESC" = "ASC"): UpdateBuilder {
    const node: import("../ast/nodes.ts").OrderByNode = {
      expr: typeof expr === "string" ? { type: "column_ref", column: expr } : expr,
      direction,
    }
    return new UpdateBuilder({
      ...this.node,
      orderBy: [...(this.node.orderBy ?? []), node],
    })
  }

  limit(n: ExpressionNode): UpdateBuilder {
    return new UpdateBuilder({ ...this.node, limit: n })
  }

  returning(...exprs: ExpressionNode[]): UpdateBuilder {
    return new UpdateBuilder({
      ...this.node,
      returning: [...this.node.returning, ...exprs],
    })
  }

  with(name: string, query: SelectNode, recursive = false): UpdateBuilder {
    const cte: CTENode = { name, query, recursive }
    return new UpdateBuilder({
      ...this.node,
      ctes: [...this.node.ctes, cte],
    })
  }

  build(): UpdateNode {
    return { ...this.node }
  }
}

export function update(table: string | TableRefNode): UpdateBuilder {
  return new UpdateBuilder().table(table)
}
