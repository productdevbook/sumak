import { and as astAnd, not as astNot, or as astOr } from "../ast/expression.ts"
import type { ExpressionNode } from "../ast/nodes.ts"
import { brandExpression } from "../ast/typed-expression.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { SumakError } from "../errors.ts"
import { UnsupportedCaslOperatorError, ucastToExpressionNode } from "./ucast-to-ast.ts"
import type { UcastCondition } from "./ucast-to-ast.ts"

/**
 * Thrown when a caller asks for the CASL-derived WHERE of an action
 * that isn't permitted for any rule. Mirrors what CASL's own
 * `rulesToAST` returns `null` for (no matching positive rule), which
 * `@casl/prisma` surfaces as a `ForbiddenError`. sumak re-uses its own
 * error class so the CASL runtime stays an optional peer dep.
 *
 * Default-throw is the secure default — silent-zero-rows hides bugs
 * where a rule was expected to match and didn't. Opt into the
 * silent-zero path at the plugin layer via
 * `caslAuthz({ onForbidden: "empty" })`.
 */
export class ForbiddenByCaslError extends SumakError {
  readonly action: string
  readonly subject: string
  constructor(action: string, subject: string) {
    super(
      `CASL: action "${action}" on subject "${subject}" is forbidden — ` +
        `no matching rule for the current ability. ` +
        `(caslToSumakWhere throws by default; use the caslAuthz plugin with ` +
        `\`onForbidden: "empty"\` if you want zero-rows semantics instead.)`,
    )
    this.name = "ForbiddenByCaslError"
    this.action = action
    this.subject = subject
  }
}

/**
 * Minimum surface we need from a CASL `Rule` — every Rule that comes
 * out of `ability.rulesFor(...)` carries `ast` (the ucast condition
 * tree) and `inverted` (true for `cannot` rules). `conditions` is
 * present on rules that were created with a conditions object; the
 * unconditional short-circuit (`can('read', 'Post')` with no object)
 * shows up as `conditions === undefined`.
 *
 * We type the fields as broadly as possible so *any* CASL rule —
 * regardless of the Ability generic parameters — matches. All we do
 * with these fields is read them and pass `ast` into the
 * ucast→ExpressionNode converter; no typed math happens on the CASL
 * side of the boundary.
 */
interface CaslRuleLike {
  readonly inverted?: boolean
  readonly conditions?: unknown
  /**
   * ucast Condition tree attached to this rule by CASL's default
   * MongoDB conditions matcher. Typed here as a loose `{ operator,
   * value }` supertype — the real `@ucast/core` Condition class is
   * the base of both FieldCondition and CompoundCondition, and
   * neither is directly assignable to the discriminated
   * {@link UcastCondition} union without a narrowing check. The
   * converter's duck-type discrimination happens inside
   * `ucastToExpressionNode` at runtime, so the type here just has
   * to be assignable-from the CASL-side Condition shape.
   */
  readonly ast?: { readonly operator: string; readonly value: unknown }
}

/**
 * Minimum surface we need from a CASL `Ability`:
 *
 *   - `rulesFor(action, subject)` → array of matching {@link CaslRuleLike},
 *     highest-priority first (same semantics as CASL's own
 *     `rulesToAST`/`rulesToQuery`).
 *
 * We intentionally don't constrain the parameter types of `rulesFor`
 * — CASL's real generic is `<T extends AnyAbility>(action: Parameters<T['rulesFor']>[0], …)`,
 * which collapses to `never` at structural-assignability time in
 * strict mode. Widening the method to `(action: any, subject: any)`
 * lets a real `PureAbility<Actions, Subjects>` instance satisfy this
 * shape without the caller casting at the call site.
 */
export interface AbilityLike {
  rulesFor(action: any, subject: any): CaslRuleLike[]
}

/**
 * Convert a CASL `Ability` + action + subject into a
 * sumak-friendly {@link Expression} that can be fed straight into
 * `.where(...)`:
 *
 * ```ts
 * import { caslToSumakWhere } from "sumak"
 *
 * // No extra import needed — we walk `ability.rulesFor(...)` directly.
 * const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })
 *
 * const rows = await db.selectFrom("posts").where(() => where).many()
 * // → SELECT ... FROM posts WHERE (authorId = $1 OR published = $2)
 * ```
 *
 * ## Algorithm
 *
 * This function reimplements CASL's own `rulesToAST` — we don't import
 * it from `@casl/ability/extra` because that function's TypeScript
 * generic (`<T extends AnyAbility>`) forces a peer-dep relationship
 * strict enough that no structural signature can accept it without
 * a caller-side cast. Re-implementing against `ability.rulesFor(...)`
 * + `rule.ast` / `rule.inverted` (both stable CASL public API) gives
 * us:
 *
 *   1. Iterate `rulesFor(action, subject)` (highest-priority first,
 *      same as CASL).
 *   2. Short-circuit on unconditional rules:
 *        - unconditional `cannot` → stop walking, emit `AND`-of the
 *          inverted rules collected so far (nothing matches beyond).
 *        - unconditional `can` → every row of the subject is allowed
 *          (modulo inverted rules collected so far).
 *   3. Otherwise split rules into positive (`can`) and inverted
 *      (`cannot`) buckets.
 *   4. Final expression:
 *        positive.length === 0 && inverted.length === 0 → throw
 *          ForbiddenByCaslError (no rule at all — denied).
 *        positive.length === 0 && inverted.length > 0  → AND of
 *          the inverted clauses (everything permitted minus those).
 *        positive.length > 0                            → OR of the
 *          positive clauses, AND-ed with the inverted clauses
 *          (standard authz semantics).
 *
 * The output expression is always parameterized — every literal value
 * travels through a `param` node. See `ucastToExpressionNode` for the
 * leaf-operator mapping and the security/three-valued-logic notes on
 * NULL handling.
 *
 * @throws {@link ForbiddenByCaslError} when no rule matches the
 *   (action, subject) pair at all.
 * @throws {@link UnsupportedCaslOperatorError} when a rule's `ast`
 *   contains an operator the v1 converter doesn't translate (regex,
 *   exists, elemMatch, all, size, or any user-registered operator).
 */
export function caslToSumakWhere(args: {
  ability: AbilityLike
  action: string
  subject: string
}): Expression<boolean> {
  const node = buildWhereNode(args.ability, args.action, args.subject)
  if (node === null) throw new ForbiddenByCaslError(args.action, args.subject)
  return brandExpression<boolean>(node)
}

/**
 * Core algorithm split out so the {@link caslAuthz} plugin can
 * distinguish "rules say forbidden" (→ null) from "every row allowed"
 * (→ `literal(true)`) without catching the error and inspecting its
 * fields. Returns:
 *
 *   - `null` when the ability has no matching rule → forbidden.
 *   - An `ExpressionNode` otherwise (may be a tautology like
 *     `literal(true)` for unconditional `can(...)`).
 *
 * @internal
 */
export function buildWhereNode(
  ability: AbilityLike,
  action: string,
  subject: string,
): ExpressionNode | null {
  const rules = ability.rulesFor(action, subject)
  const positive: ExpressionNode[] = []
  const inverted: ExpressionNode[] = []

  // Walk rules highest-priority first (CASL's contract). An
  // unconditional rule mid-walk truncates the iteration — matching
  // the short-circuit logic in CASL's internal `rulesToQuery`.
  for (const rule of rules) {
    const isUnconditional = rule.conditions === undefined || rule.conditions === null
    const isInverted = rule.inverted === true

    if (isUnconditional) {
      if (isInverted) {
        // Unconditional `cannot` → nothing past this point can match;
        // only the inverted rules collected so far still apply as
        // subtractions. The outer switch below handles the cases.
        break
      }
      // Unconditional `can` → every row allowed, but inverted rules
      // already in the bucket still subtract. We model this by
      // AND-ing all inverted clauses together; if there are no
      // inverted rules yet, the result is an empty AND → literal(true).
      return combineInvertedOnly(inverted)
    }

    if (!rule.ast) {
      // Conditional rule with no parsed AST — shouldn't happen for
      // the default MongoDB conditions matcher, which always parses.
      // Treat as unconditional for safety (the row matches the rule's
      // conditions at runtime but we can't translate to SQL) and let
      // the caller know they need to rewrite the rule for SQL use.
      throw new SumakError(
        `CASL rule for "${action}" on "${subject}" has conditions but no \`ast\` — ` +
          `sumak needs the default MongoDB conditions matcher (or any matcher that sets rule.ast) ` +
          `to translate the rule into SQL. Custom \`lambdaMatcher\`-style abilities can't be used ` +
          `with caslToSumakWhere / caslAuthz.`,
      )
    }

    // Cast to UcastCondition — the CaslRuleLike.ast type is a
    // supertype of both FieldConditionLike and CompoundConditionLike;
    // the converter's `isField`/`isCompound` duck-type checks sort
    // them out at runtime and throw UnsupportedCaslOperatorError on
    // anything else.
    const leaf = ucastToExpressionNode(rule.ast as UcastCondition)
    if (isInverted) inverted.push(leaf)
    else positive.push(leaf)
  }

  if (positive.length === 0 && inverted.length === 0) return null

  // Standard composition: (OR of positives) AND (NOT of each inverted).
  // The NOT-wrapping around each inverted leaf matches CASL's own
  // convertRuleToAST (`inverted ? CompoundCondition('not', [rule.ast])`).
  const invertedSubtraction = inverted.map((node) => astNot(node))

  if (positive.length === 0) {
    // Only inverted rules → allow-all-minus. Combine as AND-of-NOTs.
    return andAll(invertedSubtraction)
  }

  const orOfPositives = orAll(positive)
  if (invertedSubtraction.length === 0) return orOfPositives
  return astAnd(orOfPositives, andAll(invertedSubtraction))
}

function combineInvertedOnly(inverted: ExpressionNode[]): ExpressionNode {
  if (inverted.length === 0) {
    // Unconditional `can` with no prior inverted rules → WHERE TRUE.
    // Sumak's optimizer strips this from the final SQL.
    return { type: "literal", value: true }
  }
  return andAll(inverted.map((node) => astNot(node)))
}

function orAll(nodes: ExpressionNode[]): ExpressionNode {
  // CASL returns rules highest-priority first. For OR composition the
  // order of children doesn't affect correctness, but we keep it left-
  // leaning so the SQL reads top-down with the same priority order.
  return nodes.slice(1).reduce<ExpressionNode>((acc, n) => astOr(acc, n), nodes[0]!)
}

function andAll(nodes: ExpressionNode[]): ExpressionNode {
  return nodes.slice(1).reduce<ExpressionNode>((acc, n) => astAnd(acc, n), nodes[0]!)
}

// Re-export so callers have a single "casl" import point. Keeping the
// errors adjacent to the function they throw from means the try/catch
// pattern is discoverable from the function's exports alone.
export { UnsupportedCaslOperatorError }
