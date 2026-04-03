import type {
  CTENode,
  ExpressionNode,
  SelectNode,
  TableRefNode,
  UpdateNode,
} from "../ast/nodes.ts";
import { createUpdateNode } from "../ast/nodes.ts";

export class UpdateBuilder {
  private node: UpdateNode;

  constructor(node?: UpdateNode) {
    this.node = node ?? createUpdateNode({ name: "" });
  }

  table(table: string | TableRefNode): UpdateBuilder {
    const ref: TableRefNode =
      typeof table === "string" ? { type: "table_ref", name: table } : table;
    return new UpdateBuilder({ ...this.node, table: ref });
  }

  set(column: string, value: ExpressionNode): UpdateBuilder {
    return new UpdateBuilder({
      ...this.node,
      set: [...this.node.set, { column, value }],
    });
  }

  where(expr: ExpressionNode): UpdateBuilder {
    return new UpdateBuilder({ ...this.node, where: expr });
  }

  from(table: string | TableRefNode): UpdateBuilder {
    const ref: TableRefNode =
      typeof table === "string" ? { type: "table_ref", name: table } : table;
    return new UpdateBuilder({ ...this.node, from: ref });
  }

  returning(...exprs: ExpressionNode[]): UpdateBuilder {
    return new UpdateBuilder({
      ...this.node,
      returning: [...this.node.returning, ...exprs],
    });
  }

  with(name: string, query: SelectNode, recursive = false): UpdateBuilder {
    const cte: CTENode = { name, query, recursive };
    return new UpdateBuilder({
      ...this.node,
      ctes: [...this.node.ctes, cte],
    });
  }

  build(): UpdateNode {
    return { ...this.node };
  }
}

export function update(table: string | TableRefNode): UpdateBuilder {
  return new UpdateBuilder().table(table);
}
