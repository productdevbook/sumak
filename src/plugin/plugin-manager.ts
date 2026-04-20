import type { ASTNode } from "../ast/nodes.ts"
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

  /** Apply all transformNode phases in order. */
  transformNode(node: ASTNode): ASTNode {
    let result = node
    for (const plugin of this.plugins) {
      if (plugin.transformNode) {
        result = plugin.transformNode(result)
      }
    }
    return result
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
