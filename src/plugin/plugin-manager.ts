import type { ASTNode } from "../ast/nodes.ts";
import type { CompiledQuery } from "../types.ts";
import type { LalePlugin } from "./types.ts";

/**
 * Manages plugin execution pipeline.
 * Plugins are applied sequentially in registration order.
 */
export class PluginManager {
  private readonly plugins: readonly LalePlugin[];

  constructor(plugins: LalePlugin[]) {
    this.plugins = Object.freeze([...plugins]);
  }

  /** Apply all transformNode phases in order. */
  transformNode(node: ASTNode): ASTNode {
    let result = node;
    for (const plugin of this.plugins) {
      if (plugin.transformNode) {
        result = plugin.transformNode(result);
      }
    }
    return result;
  }

  /** Apply all transformQuery phases in order. */
  transformQuery(query: CompiledQuery): CompiledQuery {
    let result = query;
    for (const plugin of this.plugins) {
      if (plugin.transformQuery) {
        result = plugin.transformQuery(result);
      }
    }
    return result;
  }

  /** Apply all transformResult phases in order. */
  transformResult(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    let result = rows;
    for (const plugin of this.plugins) {
      if (plugin.transformResult) {
        result = plugin.transformResult(result);
      }
    }
    return result;
  }
}
