import type { ASTNode, CTENode, SelectNode, SubqueryNode } from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * Manages plugin execution pipeline.
 * Plugins are applied sequentially in registration order.
 *
 * **Security:** Only AST-level transforms are allowed. Plugins cannot modify
 * compiled SQL strings directly, preserving parameterization guarantees.
 */
export class PluginManager {
  private readonly plugins: readonly SumakPlugin[]

  constructor(plugins: SumakPlugin[]) {
    this.plugins = Object.freeze([...plugins])
  }

  /**
   * Apply all transformNode phases in order. The transform walks the AST:
   * after transforming the top-level node, every nested `SelectNode`
   * (CTEs, FROM subqueries, JOIN subqueries, INSERT sources, UPDATE
   * from-subqueries, EXISTS/subquery expressions) is transformed too.
   *
   * Without this walk, tenant-isolation plugins (MultiTenantPlugin) and
   * soft-delete plugins silently fail on CTEs over target tables — the
   * top-level INSERT/SELECT is filtered, but the CTE's SELECT reads raw
   * data. Idempotency flags on each plugin (e.g. MultiTenantApplied)
   * prevent double-application when a plugin already walked part of the
   * tree itself.
   */
  transformNode(node: ASTNode): ASTNode {
    // Short-circuit when no plugin implements `transformNode` — avoids
    // allocating a new AST on the hot no-plugins path and preserves
    // object identity for callers that compare with `toBe`.
    if (!this.plugins.some((p) => p.transformNode)) return node

    let result = node
    for (const plugin of this.plugins) {
      if (plugin.transformNode) {
        result = plugin.transformNode(result)
      }
    }
    return this.walkChildSelects(result)
  }

  private walkChildSelects(node: ASTNode): ASTNode {
    switch (node.type) {
      case "select":
        return this.walkSelect(node)
      case "insert": {
        const insert = node
        const ctes = insert.ctes.map((c) => this.transformCTE(c))
        const source = insert.source
          ? (this.walkSelect(insert.source) as SelectNode)
          : insert.source
        return { ...insert, ctes, source }
      }
      case "update": {
        const upd = node
        const ctes = upd.ctes.map((c) => this.transformCTE(c))
        return { ...upd, ctes }
      }
      case "delete": {
        const del = node
        const ctes = del.ctes.map((c) => this.transformCTE(c))
        return { ...del, ctes }
      }
      default:
        return node
    }
  }

  private walkSelect(node: SelectNode): SelectNode {
    const ctes = node.ctes.map((c) => this.transformCTE(c))
    const from =
      node.from && node.from.type === "subquery" ? this.transformSubquery(node.from) : node.from
    const joins = node.joins.map((j) =>
      j.table.type === "subquery" ? { ...j, table: this.transformSubquery(j.table) } : j,
    )
    return { ...node, ctes, from, joins }
  }

  private transformCTE(cte: CTENode): CTENode {
    return { ...cte, query: this.transformSelectThroughPlugins(cte.query) }
  }

  private transformSubquery(sub: SubqueryNode): SubqueryNode {
    return { ...sub, query: this.transformSelectThroughPlugins(sub.query) }
  }

  private transformSelectThroughPlugins(node: SelectNode): SelectNode {
    let result: ASTNode = node
    for (const plugin of this.plugins) {
      if (plugin.transformNode) result = plugin.transformNode(result)
    }
    // Recurse — the nested SELECT may itself contain CTEs / subqueries.
    return this.walkChildSelects(result) as SelectNode
  }

  /** Apply all transformResult phases in order. */
  transformResult(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    let result = rows
    for (const plugin of this.plugins) {
      if (plugin.transformResult) {
        result = plugin.transformResult(result)
      }
    }
    return result
  }

  /**
   * Find the first registered plugin that is an instance of the given class.
   * Used by explicit builders like `db.softDelete()` to resolve plugin config.
   */
  getByInstance<T extends SumakPlugin>(ctor: new (...args: any[]) => T): T | undefined {
    for (const p of this.plugins) {
      if (p instanceof ctor) return p as T
    }
    return undefined
  }
}
