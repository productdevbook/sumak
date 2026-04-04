import type {
  CTENode,
  ExpressionNode,
  MergeNode,
  MergeWhenMatched,
  MergeWhenNotMatched,
  SelectNode,
  SubqueryNode,
  TableRefNode,
} from "../ast/nodes.ts"
import { createMergeNode } from "../ast/nodes.ts"

export class MergeBuilder {
  private node: MergeNode
  private paramIndex: number

  constructor(node?: MergeNode, paramIndex = 0) {
    this.node =
      node ??
      createMergeNode({ type: "table_ref", name: "" }, { type: "table_ref", name: "" }, "src", {
        type: "literal",
        value: true,
      })
    this.paramIndex = paramIndex
  }

  into(table: string | TableRefNode): MergeBuilder {
    const ref: TableRefNode = typeof table === "string" ? { type: "table_ref", name: table } : table
    return new MergeBuilder({ ...this.node, target: ref }, this.paramIndex)
  }

  using(source: string | TableRefNode | SubqueryNode, alias: string): MergeBuilder {
    const src =
      typeof source === "string" ? ({ type: "table_ref", name: source } as TableRefNode) : source
    return new MergeBuilder({ ...this.node, source: src, sourceAlias: alias }, this.paramIndex)
  }

  on(expr: ExpressionNode): MergeBuilder {
    return new MergeBuilder({ ...this.node, on: expr }, this.paramIndex)
  }

  whenMatched(action: MergeWhenMatched): MergeBuilder {
    return new MergeBuilder({ ...this.node, whens: [...this.node.whens, action] }, this.paramIndex)
  }

  whenNotMatched(action: MergeWhenNotMatched): MergeBuilder {
    return new MergeBuilder({ ...this.node, whens: [...this.node.whens, action] }, this.paramIndex)
  }

  whenMatchedUpdate(
    set: { column: string; value: ExpressionNode }[],
    condition?: ExpressionNode,
  ): MergeBuilder {
    const when: MergeWhenMatched = {
      type: "matched",
      action: "update",
      set,
      condition,
    }
    return this.whenMatched(when)
  }

  whenMatchedDelete(condition?: ExpressionNode): MergeBuilder {
    const when: MergeWhenMatched = {
      type: "matched",
      action: "delete",
      condition,
    }
    return this.whenMatched(when)
  }

  whenNotMatchedInsert(
    columns: string[],
    values: ExpressionNode[],
    condition?: ExpressionNode,
  ): MergeBuilder {
    const when: MergeWhenNotMatched = {
      type: "not_matched",
      columns,
      values,
      condition,
    }
    return this.whenNotMatched(when)
  }

  with(name: string, query: SelectNode, recursive = false): MergeBuilder {
    const cte: CTENode = { name, query, recursive }
    return new MergeBuilder({ ...this.node, ctes: [...this.node.ctes, cte] }, this.paramIndex)
  }

  build(): MergeNode {
    return { ...this.node }
  }
}

export function merge(target: string | TableRefNode): MergeBuilder {
  return new MergeBuilder().into(target)
}
