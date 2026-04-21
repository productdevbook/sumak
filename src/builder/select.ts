import { col, star } from "../ast/expression.ts"
import type {
  CTENode,
  ExpressionNode,
  JoinNode,
  OrderByNode,
  QueryFlags as QueryFlagsType,
  SelectNode,
  SoftDeleteMode,
  SubqueryNode,
  TableRefNode,
  TemporalClause,
} from "../ast/nodes.ts"
import { createSelectNode } from "../ast/nodes.ts"
import type { JoinType, OrderDirection, SetOperator } from "../types.ts"
import { parseTableRef } from "../utils/table-ref.ts"

export class SelectBuilder {
  private node: SelectNode

  constructor(node?: SelectNode) {
    this.node = node ?? createSelectNode()
  }

  /** Merge a QueryFlags bitmap into the underlying node. */
  withFlags(flags: QueryFlagsType): SelectBuilder {
    return new SelectBuilder({ ...this.node, flags: (this.node.flags ?? 0) | flags })
  }

  /** Set the soft-delete mode. Last-call wins (overwrites a prior mode). */
  withSoftDeleteMode(mode: SoftDeleteMode): SelectBuilder {
    return new SelectBuilder({ ...this.node, softDeleteMode: mode })
  }

  columns(...cols: (string | ExpressionNode)[]): SelectBuilder {
    const exprs = cols.map((c) => (typeof c === "string" ? col(c) : c))
    return new SelectBuilder({ ...this.node, columns: [...this.node.columns, ...exprs] })
  }

  allColumns(): SelectBuilder {
    return new SelectBuilder({ ...this.node, columns: [...this.node.columns, star()] })
  }

  distinct(): SelectBuilder {
    return new SelectBuilder({ ...this.node, distinct: true })
  }

  distinctOn(...exprs: (string | ExpressionNode)[]): SelectBuilder {
    const nodes = exprs.map((e) => (typeof e === "string" ? col(e) : e))
    return new SelectBuilder({ ...this.node, distinct: true, distinctOn: nodes })
  }

  from(table: string | TableRefNode | SubqueryNode, alias?: string): SelectBuilder {
    if (typeof table === "string") {
      // Parse optional "schema.table" dotted form; single-part stays flat.
      return new SelectBuilder({ ...this.node, from: parseTableRef(table, alias) })
    }
    if (alias && table.type !== "subquery") {
      return new SelectBuilder({ ...this.node, from: { ...table, alias } })
    }
    return new SelectBuilder({ ...this.node, from: table })
  }

  where(expr: ExpressionNode): SelectBuilder {
    if (this.node.where) {
      return new SelectBuilder({
        ...this.node,
        where: { type: "binary_op", op: "AND", left: this.node.where, right: expr },
      })
    }
    return new SelectBuilder({ ...this.node, where: expr })
  }

  orWhere(expr: ExpressionNode): SelectBuilder {
    if (this.node.where) {
      return new SelectBuilder({
        ...this.node,
        where: { type: "binary_op", op: "OR", left: this.node.where, right: expr },
      })
    }
    return new SelectBuilder({ ...this.node, where: expr })
  }

  join(
    type: JoinType,
    table: string | TableRefNode,
    on?: ExpressionNode,
    alias?: string,
  ): SelectBuilder {
    const tableRef: TableRefNode | SubqueryNode =
      typeof table === "string" ? { type: "table_ref", name: table, alias } : table
    const join: JoinNode = { type: "join", joinType: type, table: tableRef, on }
    return new SelectBuilder({ ...this.node, joins: [...this.node.joins, join] })
  }

  innerJoin(table: string | TableRefNode, on: ExpressionNode, alias?: string): SelectBuilder {
    return this.join("INNER", table, on, alias)
  }

  leftJoin(table: string | TableRefNode, on: ExpressionNode, alias?: string): SelectBuilder {
    return this.join("LEFT", table, on, alias)
  }

  rightJoin(table: string | TableRefNode, on: ExpressionNode, alias?: string): SelectBuilder {
    return this.join("RIGHT", table, on, alias)
  }

  innerJoinLateral(subquery: SubqueryNode, on: ExpressionNode): SelectBuilder {
    const join: JoinNode = { type: "join", joinType: "INNER", table: subquery, on, lateral: true }
    return new SelectBuilder({ ...this.node, joins: [...this.node.joins, join] })
  }

  leftJoinLateral(subquery: SubqueryNode, on: ExpressionNode): SelectBuilder {
    const join: JoinNode = { type: "join", joinType: "LEFT", table: subquery, on, lateral: true }
    return new SelectBuilder({ ...this.node, joins: [...this.node.joins, join] })
  }

  crossJoinLateral(subquery: SubqueryNode): SelectBuilder {
    const join: JoinNode = { type: "join", joinType: "CROSS", table: subquery, lateral: true }
    return new SelectBuilder({ ...this.node, joins: [...this.node.joins, join] })
  }

  groupBy(...exprs: (string | ExpressionNode)[]): SelectBuilder {
    const nodes = exprs.map((e) => (typeof e === "string" ? col(e) : e))
    return new SelectBuilder({ ...this.node, groupBy: [...this.node.groupBy, ...nodes] })
  }

  having(expr: ExpressionNode): SelectBuilder {
    return new SelectBuilder({ ...this.node, having: expr })
  }

  orderBy(
    expr: string | ExpressionNode,
    direction: OrderDirection = "ASC",
    nulls?: "FIRST" | "LAST",
  ): SelectBuilder {
    if (typeof expr === "string" && /\s/.test(expr)) {
      // `orderBy("price DESC")` used to be quoted as `"price DESC" ASC` —
      // silent wrong SQL. Column names with whitespace are rare enough
      // that the footgun isn't worth supporting; point the caller at
      // the second argument.
      throw new Error(
        `orderBy(${JSON.stringify(expr)}) — column names may not contain spaces. ` +
          "Pass the direction as the second argument: " +
          `orderBy(${JSON.stringify(expr.split(/\s+/)[0])}, "${expr.split(/\s+/).slice(-1)[0]?.toUpperCase() || "ASC"}")`,
      )
    }
    const node: OrderByNode = {
      expr: typeof expr === "string" ? col(expr) : expr,
      direction,
      nulls,
    }
    return new SelectBuilder({ ...this.node, orderBy: [...this.node.orderBy, node] })
  }

  limit(expr: ExpressionNode): SelectBuilder {
    return new SelectBuilder({ ...this.node, limit: expr })
  }

  offset(expr: ExpressionNode): SelectBuilder {
    return new SelectBuilder({ ...this.node, offset: expr })
  }

  forSystemTime(clause: TemporalClause): SelectBuilder {
    if (!this.node.from || this.node.from.type !== "table_ref") return this
    return new SelectBuilder({
      ...this.node,
      from: { ...this.node.from, temporal: clause },
    })
  }

  forUpdate(): SelectBuilder {
    return new SelectBuilder({ ...this.node, lock: { mode: "UPDATE" } })
  }

  forShare(): SelectBuilder {
    return new SelectBuilder({ ...this.node, lock: { mode: "SHARE" } })
  }

  forNoKeyUpdate(): SelectBuilder {
    return new SelectBuilder({ ...this.node, lock: { mode: "NO KEY UPDATE" } })
  }

  forKeyShare(): SelectBuilder {
    return new SelectBuilder({ ...this.node, lock: { mode: "KEY SHARE" } })
  }

  skipLocked(): SelectBuilder {
    if (!this.node.lock) return this
    return new SelectBuilder({ ...this.node, lock: { ...this.node.lock, skipLocked: true } })
  }

  noWait(): SelectBuilder {
    if (!this.node.lock) return this
    return new SelectBuilder({ ...this.node, lock: { ...this.node.lock, noWait: true } })
  }

  /**
   * Restrict `FOR UPDATE / FOR SHARE` to specific tables (PG `OF` clause).
   * No-op if no lock has been set yet.
   */
  lockOf(tables: string[]): SelectBuilder {
    if (!this.node.lock || tables.length === 0) return this
    return new SelectBuilder({ ...this.node, lock: { ...this.node.lock, of: tables } })
  }

  with(name: string, query: SelectNode, recursive = false): SelectBuilder {
    const cte: CTENode = { name, query, recursive }
    return new SelectBuilder({ ...this.node, ctes: [...this.node.ctes, cte] })
  }

  union(query: SelectNode): SelectBuilder {
    return this.setOp("UNION", query)
  }

  unionAll(query: SelectNode): SelectBuilder {
    return this.setOp("UNION ALL", query)
  }

  intersect(query: SelectNode): SelectBuilder {
    return this.setOp("INTERSECT", query)
  }

  intersectAll(query: SelectNode): SelectBuilder {
    return this.setOp("INTERSECT ALL", query)
  }

  except(query: SelectNode): SelectBuilder {
    return this.setOp("EXCEPT", query)
  }

  exceptAll(query: SelectNode): SelectBuilder {
    return this.setOp("EXCEPT ALL", query)
  }

  private setOp(op: SetOperator, query: SelectNode): SelectBuilder {
    // Chain-friendly: if this node already has a setOp, append the new
    // operation to the end of the chain instead of overwriting it.
    // Without this, `q1.union(q2).union(q3)` silently dropped q2 because
    // the second `.union()` replaced `setOp.query` instead of extending.
    if (this.node.setOp) {
      const appended = appendSetOp(this.node.setOp, { op, query })
      return new SelectBuilder({ ...this.node, setOp: appended })
    }
    return new SelectBuilder({ ...this.node, setOp: { op, query } })
  }

  build(): SelectNode {
    return { ...this.node }
  }
}

export function select(...cols: (string | ExpressionNode)[]): SelectBuilder {
  const builder = new SelectBuilder()
  if (cols.length > 0) {
    return builder.columns(...cols)
  }
  return builder.allColumns()
}

/**
 * Walk a setOp chain to its tail and append the new setOp there.
 * Preserves the left-associative chain order so
 * `q1.union(q2).union(q3)` emits `q1 UNION q2 UNION q3` — the second
 * `.union(q3)` hooks onto the end of `q1`'s existing chain, not onto
 * its root, so q2 is not silently dropped.
 */
function appendSetOp(
  existing: { op: SetOperator; query: SelectNode },
  next: { op: SetOperator; query: SelectNode },
): { op: SetOperator; query: SelectNode } {
  if (!existing.query.setOp) {
    return {
      op: existing.op,
      query: { ...existing.query, setOp: next },
    }
  }
  return {
    op: existing.op,
    query: { ...existing.query, setOp: appendSetOp(existing.query.setOp, next) },
  }
}
