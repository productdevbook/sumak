import type { ASTNode } from "../ast/nodes.ts"

/**
 * A declarative rewrite rule for AST optimization.
 *
 * Inspired by Datalog-style bottom-up evaluation:
 * rules are applied repeatedly until a fixpoint (no more changes).
 *
 * Users can register custom rules via `db.optimize(rule)`.
 */
export interface RewriteRule {
  /** Unique rule name for debugging and ordering. */
  readonly name: string
  /** Return true if this rule can apply to the given node. */
  match(node: ASTNode): boolean
  /** Apply the rewrite. Must return a new node (never mutate). */
  apply(node: ASTNode): ASTNode
}

/**
 * Optimizer configuration.
 */
export interface OptimizeOptions {
  /** Maximum iterations before giving up (prevents infinite loops). Default: 10 */
  maxIterations?: number
  /** Rules to apply. Default: built-in rules */
  rules?: RewriteRule[]
  /** Disable specific built-in rules by name. */
  disableRules?: string[]
}

export const DEFAULT_OPTIMIZE_OPTIONS: Required<Omit<OptimizeOptions, "rules" | "disableRules">> = {
  maxIterations: 10,
}
