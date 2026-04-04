import type { ExpressionNode } from "../ast/nodes.ts"

/**
 * Semantic domain for NbE (Normalization by Evaluation).
 *
 * The normalizer evaluates AST nodes into a canonical semantic domain,
 * then reifies them back into normal-form AST nodes.
 *
 * This separates "what the query means" from "how it was written".
 */

/**
 * A predicate in conjunctive normal form (CNF).
 * Top-level is AND, each clause is a disjunction (OR) of atoms.
 *
 * Example: `(a = 1 AND b = 2 AND (c = 3 OR c = 4))`
 * → `[[a=1], [b=2], [c=3, c=4]]`
 *
 * This representation makes deduplication and simplification trivial.
 */
export interface CNF {
  /** Each inner array is a disjunction (OR). Top-level is conjunction (AND). */
  clauses: ExpressionNode[][]
}

/**
 * Normalization options.
 */
export interface NormalizeOptions {
  /** Flatten nested AND/OR into CNF. Default: true */
  flattenLogical?: boolean
  /** Remove duplicate predicates. Default: true */
  deduplicatePredicates?: boolean
  /** Simplify tautologies (WHERE true) and contradictions (WHERE false). Default: true */
  simplifyTautologies?: boolean
  /** Fold constant expressions (1 + 2 → 3). Default: true */
  foldConstants?: boolean
  /** Simplify double negation (NOT NOT x → x). Default: true */
  simplifyNegation?: boolean
}

export const DEFAULT_NORMALIZE_OPTIONS: Required<NormalizeOptions> = {
  flattenLogical: true,
  deduplicatePredicates: true,
  simplifyTautologies: true,
  foldConstants: true,
  simplifyNegation: true,
}
