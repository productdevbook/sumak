import type {
  ASTNode,
  DeleteNode,
  ExplainNode,
  InsertNode,
  MergeNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { ASTWalker } from "../ast/walker.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * Manages plugin execution pipeline.
 * Plugins are applied sequentially in registration order.
 *
 * **Security:** Only AST-level transforms are allowed. Plugins cannot modify
 * compiled SQL strings directly, preserving parameterization guarantees.
 *
 * **Traversal.** The manager extends {@link ASTWalker}: every
 * nested `SelectNode` reached through CTEs, FROM/JOIN subqueries,
 * INSERT sources, UPDATE/DELETE joins, WHERE/HAVING/EXISTS/IN
 * subqueries, MERGE source + WHEN conditions, EXPLAIN statements, and
 * expression-level subqueries is passed through the plugin chain. The
 * walker's exhaustive switch guarantees we fail the compile when a new
 * AST variant is added without updating the traversal.
 */
export class PluginManager extends ASTWalker {
  private readonly plugins: readonly SumakPlugin[]

  constructor(plugins: SumakPlugin[]) {
    super()
    this.plugins = Object.freeze([...plugins])
  }

  /**
   * Apply all `transformNode` phases in order to the top-level node, then
   * descend into every nested statement / expression slot and re-apply
   * the chain to each `SelectNode` encountered. Idempotency flags on
   * individual plugins (e.g. `MultiTenantApplied`) keep double-applied
   * transforms from stacking.
   */
  transformNode(node: ASTNode): ASTNode {
    // Short-circuit when no plugin implements `transformNode` — avoids
    // allocating a new AST on the hot no-plugins path and preserves
    // object identity for callers that compare with `toBe`.
    if (!this.plugins.some((p) => p.transformNode)) return node

    // Dispatching through visitNode already applies the plugin chain at
    // every SelectNode / DML node it reaches (see the visit* overrides).
    // Top-level chain application is done inside those overrides too.
    return this.visitNode(node)
  }

  private applyPluginChain(node: ASTNode): ASTNode {
    let result = node
    for (const plugin of this.plugins) {
      if (plugin.transformNode) result = plugin.transformNode(result)
    }
    return result
  }

  // ── Walker overrides: push each nested SELECT through the plugin chain
  //    on the way in, so inner SELECTs get the same plugin treatment as
  //    the outer query. visitSelect (and sibling DML visitors) run the
  //    chain and then delegate to the base walker to recurse into this
  //    node's own children.

  override visitSelect(node: SelectNode): SelectNode {
    const transformed = this.applyPluginChain(node) as SelectNode
    return super.visitSelect(transformed)
  }

  override visitInsert(node: InsertNode): InsertNode {
    const transformed = this.applyPluginChain(node) as InsertNode
    return super.visitInsert(transformed)
  }

  override visitUpdate(node: UpdateNode): UpdateNode {
    const transformed = this.applyPluginChain(node) as UpdateNode
    return super.visitUpdate(transformed)
  }

  override visitDelete(node: DeleteNode): DeleteNode {
    const transformed = this.applyPluginChain(node) as DeleteNode
    return super.visitDelete(transformed)
  }

  override visitMerge(node: MergeNode): MergeNode {
    const transformed = this.applyPluginChain(node) as MergeNode
    return super.visitMerge(transformed)
  }

  override visitExplain(node: ExplainNode): ExplainNode {
    // EXPLAIN itself is not a DML target plugins rewrite — but its
    // inner statement is, and the base walker already routes it through
    // visitNode → visit{Select,Insert,...} which re-apply the chain.
    return super.visitExplain(node)
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
