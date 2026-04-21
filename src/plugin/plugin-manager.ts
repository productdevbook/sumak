import type { ASTNode, CTENode, ExpressionNode, SelectNode, SubqueryNode } from "../ast/nodes.ts"
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
        const joins = upd.joins.map((j) =>
          j.table.type === "subquery" ? { ...j, table: this.transformSubquery(j.table) } : j,
        )
        // Same WHERE-subquery traversal as SELECT: without this,
        // `UPDATE products SET … WHERE EXISTS (SELECT … FROM tenants)`
        // leaves the EXISTS subquery unfiltered.
        const where = upd.where ? this.walkExpression(upd.where) : upd.where
        return { ...upd, ctes, joins, where }
      }
      case "delete": {
        const del = node
        const ctes = del.ctes.map((c) => this.transformCTE(c))
        const joins = del.joins.map((j) =>
          j.table.type === "subquery" ? { ...j, table: this.transformSubquery(j.table) } : j,
        )
        const where = del.where ? this.walkExpression(del.where) : del.where
        return { ...del, ctes, joins, where }
      }
      case "merge": {
        // Every MERGE slot that can carry a SELECT needs to walk
        // through the plugin chain — a correlated subquery in any
        // of these positions bypasses MultiTenant / SoftDelete filters.
        const mrg = node
        const ctes = mrg.ctes.map((c) => this.transformCTE(c))
        const source =
          mrg.source.type === "subquery" ? this.transformSubquery(mrg.source) : mrg.source
        const on = this.walkExpression(mrg.on)
        const whens = mrg.whens.map((w) => {
          if (w.type === "matched") {
            const condition = w.condition ? this.walkExpression(w.condition) : w.condition
            const set = w.set?.map((s) => ({ ...s, value: this.walkExpression(s.value) }))
            return { ...w, condition, set }
          }
          // not_matched
          const condition = w.condition ? this.walkExpression(w.condition) : w.condition
          const values = w.values.map((v) => this.walkExpression(v))
          return { ...w, condition, values }
        })
        return { ...mrg, ctes, source, on, whens }
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
    // Descend into WHERE / HAVING expression trees. Without this,
    // `WHERE EXISTS (SELECT ... FROM users)` over a tenant-aware table
    // bypasses MultiTenant / SoftDelete — the inner SELECT is invisible
    // to the manager's subquery traversal because it lives in an
    // expression, not in FROM/JOIN.
    const where = node.where ? this.walkExpression(node.where) : node.where
    const having = node.having ? this.walkExpression(node.having) : node.having
    return { ...node, ctes, from, joins, where, having }
  }

  /**
   * Walk an expression tree, replacing every nested `SelectNode` it
   * carries (via `subquery`, `exists`, or `in`-with-subquery) with the
   * plugin-transformed version. Keeps the outer ExpressionNode shape
   * intact.
   */
  private walkExpression(expr: ExpressionNode): ExpressionNode {
    switch (expr.type) {
      case "subquery":
        return this.transformSubquery(expr)
      case "exists":
        return { ...expr, query: this.transformSelectThroughPlugins(expr.query) }
      case "in": {
        // `InNode.values` is either `ExpressionNode[]` or a bare
        // `SelectNode` (subquery IN). Walk into the SELECT through the
        // plugin chain so a tenant-aware table there still gets filtered.
        const values = Array.isArray(expr.values)
          ? expr.values.map((v) => this.walkExpression(v))
          : this.transformSelectThroughPlugins(expr.values)
        return {
          ...expr,
          expr: this.walkExpression(expr.expr),
          values,
        }
      }
      case "binary_op":
        return {
          ...expr,
          left: this.walkExpression(expr.left),
          right: this.walkExpression(expr.right),
        }
      case "unary_op":
        return { ...expr, operand: this.walkExpression(expr.operand) }
      case "is_null":
        return { ...expr, expr: this.walkExpression(expr.expr) }
      case "between":
        return {
          ...expr,
          expr: this.walkExpression(expr.expr),
          low: this.walkExpression(expr.low),
          high: this.walkExpression(expr.high),
        }
      case "cast":
        return { ...expr, expr: this.walkExpression(expr.expr) }
      case "case":
        return {
          ...expr,
          operand: expr.operand ? this.walkExpression(expr.operand) : expr.operand,
          whens: expr.whens.map((w) => ({
            condition: this.walkExpression(w.condition),
            result: this.walkExpression(w.result),
          })),
          else_: expr.else_ ? this.walkExpression(expr.else_) : expr.else_,
        }
      case "function_call":
        return {
          ...expr,
          args: expr.args.map((a) => this.walkExpression(a)),
          filter: expr.filter ? this.walkExpression(expr.filter) : expr.filter,
        }
      case "aliased_expr":
        return { ...expr, expr: this.walkExpression(expr.expr) }
      default:
        // literal, column_ref, star, param, raw, json_access,
        // full_text_search, window_function, tuple, array_expr:
        // none can carry a SelectNode without going through one of the
        // handled wrappers above. Leave as-is.
        return expr
    }
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
