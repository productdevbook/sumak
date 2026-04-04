import type { ASTNode } from "../ast/nodes.ts"
import type { CompiledQuery } from "../types.ts"

/**
 * Plugin interface for sumak.
 *
 * Plugins can intercept at three points:
 * 1. transformNode — modify the AST before compilation
 * 2. transformQuery — modify the compiled SQL after generation
 * 3. transformResult — modify result rows after execution
 */
export interface SumakPlugin {
  readonly name: string

  /** Transform AST before compilation. Return a new node (never mutate). */
  transformNode?(node: ASTNode): ASTNode

  /** Transform compiled query after SQL generation. */
  transformQuery?(query: CompiledQuery): CompiledQuery

  /** Transform result rows after execution. */
  transformResult?(rows: Record<string, unknown>[]): Record<string, unknown>[]
}
