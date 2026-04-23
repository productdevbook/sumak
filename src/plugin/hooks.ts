import type { ASTNode, DeleteNode, InsertNode, SelectNode, UpdateNode } from "../ast/nodes.ts"
import type { CompiledQuery } from "../types.ts"
import type { ResultContext } from "./types.ts"

/**
 * Hook context passed to hook handlers.
 */
export interface HookContext<T extends ASTNode = ASTNode> {
  /** The AST node being processed */
  node: T
  /** Table name (if applicable) */
  table?: string
  /** Compiled query (only in after hooks) */
  query?: CompiledQuery
}

/**
 * All available hook points in the query lifecycle.
 */
export interface SumakHooks {
  /** Fires before any query is compiled. Can modify the AST. */
  "query:before": (ctx: HookContext) => ASTNode | void
  /** Fires after a query is compiled to SQL. Can modify the compiled query. */
  "query:after": (ctx: HookContext & { query: CompiledQuery }) => CompiledQuery | void

  /** Fires before SELECT compilation. Can modify the SelectNode. */
  "select:before": (ctx: HookContext<SelectNode>) => SelectNode | void
  /** Fires before INSERT compilation. Can modify the InsertNode. */
  "insert:before": (ctx: HookContext<InsertNode>) => InsertNode | void
  /** Fires before UPDATE compilation. Can modify the UpdateNode. */
  "update:before": (ctx: HookContext<UpdateNode>) => UpdateNode | void
  /** Fires before DELETE compilation. Can modify the DeleteNode. */
  "delete:before": (ctx: HookContext<DeleteNode>) => DeleteNode | void

  /**
   * Transform result rows. `ctx` (optional) carries AST context — the
   * source table and a column→table map — for enrichers that need to
   * know which query produced the rows. Handlers using the old
   * single-arg signature continue to work: `ctx` just goes unread.
   */
  "result:transform": (
    rows: Record<string, unknown>[],
    ctx?: ResultContext,
  ) => Record<string, unknown>[]
}

export type HookName = keyof SumakHooks

/**
 * Hookable system — register and execute hooks.
 *
 * ```ts
 * const hooks = new Hookable();
 * hooks.hook("select:before", (ctx) => {
 *   // Add soft delete filter
 *   return { ...ctx.node, where: addSoftDelete(ctx.node.where) };
 * });
 * ```
 */
export class Hookable {
  private _hooks: Map<string, Function[]> = new Map()

  /**
   * Register a hook handler.
   * Returns an unregister function.
   */
  hook<K extends HookName>(name: K, handler: SumakHooks[K]): () => void {
    if (!this._hooks.has(name)) {
      this._hooks.set(name, [])
    }
    this._hooks.get(name)!.push(handler)

    return () => {
      const handlers = this._hooks.get(name)
      if (handlers) {
        const idx = handlers.indexOf(handler)
        if (idx !== -1) handlers.splice(idx, 1)
      }
    }
  }

  /**
   * Execute all handlers for a hook.
   * For AST hooks: each handler can return a modified node, which feeds into the next.
   * For result hooks: each handler transforms the rows.
   */
  callHook<K extends HookName>(
    name: K,
    ...args: Parameters<SumakHooks[K]>
  ): ReturnType<SumakHooks[K]> | undefined {
    const handlers = this._hooks.get(name)
    if (!handlers || handlers.length === 0) return undefined

    let result: any = undefined
    // For AST hooks we clone the ctx per iteration so a later handler sees the
    // previous handler's returned node, without mutating the caller's ctx
    // (plugins that stored a reference to ctx shouldn't observe the rewrite).
    const isAstHook =
      name !== "result:transform" &&
      args[0] &&
      typeof args[0] === "object" &&
      "node" in (args[0] as object)
    let currentArgs = args
    for (const handler of handlers) {
      const ret = handler(...currentArgs)
      if (ret !== undefined) {
        result = ret
        if (isAstHook) {
          const ctxCopy = { ...(currentArgs[0] as object), node: ret }
          currentArgs = [ctxCopy, ...currentArgs.slice(1)] as typeof currentArgs
        }
      }
    }
    return result
  }

  /**
   * Check if any handlers are registered for a hook.
   */
  hasHook(name: HookName): boolean {
    const handlers = this._hooks.get(name)
    return handlers !== undefined && handlers.length > 0
  }

  /**
   * Remove all handlers for a hook.
   */
  removeHook(name: HookName): void {
    this._hooks.delete(name)
  }

  /**
   * Remove all hooks.
   */
  removeAllHooks(): void {
    this._hooks.clear()
  }
}
