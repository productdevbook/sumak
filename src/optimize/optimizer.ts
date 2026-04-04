import type { ASTNode } from "../ast/nodes.ts"
import { normalizeQuery } from "../normalize/query.ts"
import type { NormalizeOptions } from "../normalize/types.ts"
import { BUILTIN_RULES } from "./rules.ts"
import type { OptimizeOptions, RewriteRule } from "./types.ts"
import { DEFAULT_OPTIMIZE_OPTIONS } from "./types.ts"

/**
 * Full optimization pipeline: Normalize → Rewrite Rules (to fixpoint).
 *
 * The normalizer reduces expressions to canonical form (NbE).
 * The optimizer applies rewrite rules bottom-up until no more changes occur.
 *
 * ```
 * AST → normalize(NbE) → optimize(rules, fixpoint) → optimized AST
 * ```
 */
export function optimize(
  node: ASTNode,
  opts?: OptimizeOptions & { normalize?: NormalizeOptions },
): ASTNode {
  // Phase 1: Normalize
  let result = normalizeQuery(node, opts?.normalize)

  // Phase 2: Apply rewrite rules to fixpoint
  const maxIterations = opts?.maxIterations ?? DEFAULT_OPTIMIZE_OPTIONS.maxIterations
  const disableSet = new Set(opts?.disableRules ?? [])
  const rules = (opts?.rules ?? BUILTIN_RULES).filter((r) => !disableSet.has(r.name))

  for (let i = 0; i < maxIterations; i++) {
    const next = applyRules(result, rules)
    if (next === result) break // fixpoint reached
    result = next
  }

  return result
}

/**
 * Apply all matching rules once. Returns same reference if nothing changed.
 */
function applyRules(node: ASTNode, rules: RewriteRule[]): ASTNode {
  let result = node
  let changed = false

  for (const rule of rules) {
    if (rule.match(result)) {
      const next = rule.apply(result)
      if (next !== result) {
        result = next
        changed = true
      }
    }
  }

  return changed ? result : node
}

/**
 * Create a custom rewrite rule.
 *
 * ```ts
 * const myRule = createRule({
 *   name: "my-optimization",
 *   match: (node) => node.type === "select" && hasPattern(node),
 *   apply: (node) => transformPattern(node),
 * })
 * ```
 */
export function createRule(rule: RewriteRule): RewriteRule {
  return rule
}
