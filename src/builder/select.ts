import type {
  CTENode,
  ExpressionNode,
  JoinNode,
  OrderByNode,
  SelectNode,
  SubqueryNode,
  TableRefNode,
} from "../ast/nodes.ts";
import { createSelectNode } from "../ast/nodes.ts";
import { col, star } from "../ast/expression.ts";
import type { JoinType, OrderDirection, SetOperator } from "../types.ts";

export class SelectBuilder {
  private node: SelectNode;

  constructor(node?: SelectNode) {
    this.node = node ?? createSelectNode();
  }

  columns(...cols: (string | ExpressionNode)[]): SelectBuilder {
    const exprs = cols.map((c) => (typeof c === "string" ? col(c) : c));
    return new SelectBuilder({ ...this.node, columns: [...this.node.columns, ...exprs] });
  }

  allColumns(): SelectBuilder {
    return new SelectBuilder({ ...this.node, columns: [...this.node.columns, star()] });
  }

  distinct(): SelectBuilder {
    return new SelectBuilder({ ...this.node, distinct: true });
  }

  from(table: string | TableRefNode | SubqueryNode, alias?: string): SelectBuilder {
    if (typeof table === "string") {
      const ref: TableRefNode = { name: table, alias };
      return new SelectBuilder({ ...this.node, from: ref });
    }
    if (alias && table.type !== "subquery") {
      return new SelectBuilder({ ...this.node, from: { ...table, alias } });
    }
    return new SelectBuilder({ ...this.node, from: table });
  }

  where(expr: ExpressionNode): SelectBuilder {
    return new SelectBuilder({ ...this.node, where: expr });
  }

  join(
    type: JoinType,
    table: string | TableRefNode,
    on?: ExpressionNode,
    alias?: string,
  ): SelectBuilder {
    const tableRef: TableRefNode | SubqueryNode =
      typeof table === "string" ? { name: table, alias } : table;
    const join: JoinNode = { joinType: type, table: tableRef, on };
    return new SelectBuilder({ ...this.node, joins: [...this.node.joins, join] });
  }

  innerJoin(table: string | TableRefNode, on: ExpressionNode, alias?: string): SelectBuilder {
    return this.join("INNER", table, on, alias);
  }

  leftJoin(table: string | TableRefNode, on: ExpressionNode, alias?: string): SelectBuilder {
    return this.join("LEFT", table, on, alias);
  }

  rightJoin(table: string | TableRefNode, on: ExpressionNode, alias?: string): SelectBuilder {
    return this.join("RIGHT", table, on, alias);
  }

  groupBy(...exprs: (string | ExpressionNode)[]): SelectBuilder {
    const nodes = exprs.map((e) => (typeof e === "string" ? col(e) : e));
    return new SelectBuilder({ ...this.node, groupBy: [...this.node.groupBy, ...nodes] });
  }

  having(expr: ExpressionNode): SelectBuilder {
    return new SelectBuilder({ ...this.node, having: expr });
  }

  orderBy(
    expr: string | ExpressionNode,
    direction: OrderDirection = "ASC",
    nulls?: "FIRST" | "LAST",
  ): SelectBuilder {
    const node: OrderByNode = {
      expr: typeof expr === "string" ? col(expr) : expr,
      direction,
      nulls,
    };
    return new SelectBuilder({ ...this.node, orderBy: [...this.node.orderBy, node] });
  }

  limit(expr: ExpressionNode): SelectBuilder {
    return new SelectBuilder({ ...this.node, limit: expr });
  }

  offset(expr: ExpressionNode): SelectBuilder {
    return new SelectBuilder({ ...this.node, offset: expr });
  }

  forUpdate(): SelectBuilder {
    return new SelectBuilder({ ...this.node, forUpdate: true });
  }

  with(name: string, query: SelectNode, recursive = false): SelectBuilder {
    const cte: CTENode = { name, query, recursive };
    return new SelectBuilder({ ...this.node, ctes: [...this.node.ctes, cte] });
  }

  union(query: SelectNode): SelectBuilder {
    return this.setOp("UNION", query);
  }

  unionAll(query: SelectNode): SelectBuilder {
    return this.setOp("UNION ALL", query);
  }

  intersect(query: SelectNode): SelectBuilder {
    return this.setOp("INTERSECT", query);
  }

  except(query: SelectNode): SelectBuilder {
    return this.setOp("EXCEPT", query);
  }

  private setOp(op: SetOperator, query: SelectNode): SelectBuilder {
    return new SelectBuilder({ ...this.node, setOp: { op, query } });
  }

  build(): SelectNode {
    return { ...this.node };
  }
}

export function select(...cols: (string | ExpressionNode)[]): SelectBuilder {
  const builder = new SelectBuilder();
  if (cols.length > 0) {
    return builder.columns(...cols);
  }
  return builder.allColumns();
}
