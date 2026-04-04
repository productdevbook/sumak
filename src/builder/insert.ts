import type {
  CTENode,
  ExpressionNode,
  InsertNode,
  OnConflictNode,
  SelectNode,
  TableRefNode,
} from "../ast/nodes.ts"
import { createInsertNode } from "../ast/nodes.ts"
import { param } from "../ast/expression.ts"

export class InsertBuilder {
  private node: InsertNode
  private paramIndex: number

  constructor(node?: InsertNode, paramIndex = 0) {
    this.node = node ?? createInsertNode({ name: "" })
    this.paramIndex = paramIndex
  }

  into(table: string | TableRefNode): InsertBuilder {
    const ref: TableRefNode = typeof table === "string" ? { type: "table_ref", name: table } : table
    return new InsertBuilder({ ...this.node, table: ref }, this.paramIndex)
  }

  columns(...cols: string[]): InsertBuilder {
    return new InsertBuilder(
      { ...this.node, columns: [...this.node.columns, ...cols] },
      this.paramIndex,
    )
  }

  values(...vals: unknown[]): InsertBuilder {
    let idx = this.paramIndex
    const row: ExpressionNode[] = vals.map((v) => {
      const p = param(idx, v)
      idx++
      return p
    })
    return new InsertBuilder({ ...this.node, values: [...this.node.values, row] }, idx)
  }

  returning(...exprs: ExpressionNode[]): InsertBuilder {
    return new InsertBuilder(
      { ...this.node, returning: [...this.node.returning, ...exprs] },
      this.paramIndex,
    )
  }

  onConflictDoNothing(...columns: string[]): InsertBuilder {
    const conflict: OnConflictNode = {
      columns,
      action: "nothing",
    }
    return new InsertBuilder({ ...this.node, onConflict: conflict }, this.paramIndex)
  }

  onConflictDoUpdate(
    columns: string[],
    set: { column: string; value: ExpressionNode }[],
    where?: ExpressionNode,
  ): InsertBuilder {
    const conflict: OnConflictNode = {
      columns,
      action: { set },
      where,
    }
    return new InsertBuilder({ ...this.node, onConflict: conflict }, this.paramIndex)
  }

  with(name: string, query: SelectNode, recursive = false): InsertBuilder {
    const cte: CTENode = { name, query, recursive }
    return new InsertBuilder({ ...this.node, ctes: [...this.node.ctes, cte] }, this.paramIndex)
  }

  build(): InsertNode {
    return { ...this.node }
  }
}

export function insert(table: string | TableRefNode): InsertBuilder {
  return new InsertBuilder().into(table)
}
