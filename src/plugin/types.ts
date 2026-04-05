import type { ASTNode } from "../ast/nodes.ts"

/**
 * Plugin interface for sumak.
 *
 * Plugins can intercept at two points:
 * 1. transformNode — modify the AST before compilation (safe: structural guarantees preserved)
 * 2. transformResult — modify result rows after execution
 *
 * **Security note:** `transformQuery` was removed because it allowed plugins to modify
 * compiled SQL strings directly, bypassing parameterization and enabling injection.
 * Use `transformNode` to modify queries at the AST level instead.
 */
export interface SumakPlugin {
  readonly name: string

  /** Transform AST before compilation. Return a new node (never mutate). */
  transformNode?(node: ASTNode): ASTNode

  /** Transform result rows after execution. */
  transformResult?(rows: Record<string, unknown>[]): Record<string, unknown>[]
}
