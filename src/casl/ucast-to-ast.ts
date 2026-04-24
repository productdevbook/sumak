import {
  and,
  binOp,
  col,
  eq,
  gt,
  gte,
  inList,
  isNull,
  lt,
  lte,
  neq,
  not,
  or,
  param,
} from "../ast/expression.ts"
import type { ExpressionNode } from "../ast/nodes.ts"
import { SumakError } from "../errors.ts"

/**
 * Thrown when a CASL rule uses a ucast operator that the v1 converter
 * cannot translate into a Sumak ExpressionNode. We surface these at
 * translation time (eagerly, with the offending operator name) instead
 * of silently dropping the clause — a missing predicate in an authz
 * filter is a security bug, not a soft failure.
 *
 * Operators deliberately unsupported in v1:
 *   - `regex`   — dialect-specific syntax (PG `~`, MySQL `REGEXP`, SQLite
 *                 requires a function, MSSQL has no native equivalent);
 *                 the converter is dialect-free, so we refuse rather
 *                 than emit something that works on one engine and
 *                 silently matches nothing elsewhere.
 *   - `exists`  — `$exists` in a CASL condition usually means "field is
 *                 set on the document"; mapping that to SQL depends on
 *                 whether the column is NOT NULL, nullable, or stored
 *                 in JSON. A future dialect-aware pass can do this.
 *   - `elemMatch`, `all`, `size` — array operators that make sense for
 *                 MongoDB documents; in SQL they require array-column
 *                 awareness which is dialect- and schema-dependent.
 *
 * Callers who hit this error should either adjust their CASL rules to
 * use only the v1-supported operators (`eq`, `ne`, `in`, `nin`, `gt`,
 * `gte`, `lt`, `lte`, `and`, `or`, `not`) or run the check outside the
 * database layer.
 */
export class UnsupportedCaslOperatorError extends SumakError {
  readonly operator: string
  constructor(operator: string, context?: string) {
    const where = context ? ` (at ${context})` : ""
    super(
      `CASL → Sumak AST: operator "${operator}" is not supported in v1${where}. ` +
        `v1 supports: eq, ne, in, nin, gt, gte, lt, lte, and, or, not. ` +
        `See UnsupportedCaslOperatorError docs for the rationale.`,
    )
    this.name = "UnsupportedCaslOperatorError"
    this.operator = operator
  }
}

/**
 * Minimal shape for a ucast `FieldCondition`. `@ucast/core` exports it
 * as a class; we accept either an instance or a plain-object that
 * matches this shape, so callers are free to either `import { Condition
 * } from "@ucast/core"` or to hand-build a compatible literal. Checking
 * shape instead of `instanceof` also means the converter keeps working
 * across multiple copies of `@ucast/core` in a monorepo.
 */
interface FieldConditionLike {
  readonly operator: string
  readonly field: string
  readonly value: unknown
}

/**
 * Minimal shape for a ucast `CompoundCondition` (`and` / `or` / `not`).
 * `value` is an array of child conditions — confusingly reusing the
 * base `Condition.value` slot, but that's how ucast models it.
 */
interface CompoundConditionLike {
  readonly operator: string
  readonly value: readonly UcastCondition[]
}

/**
 * ucast AST node accepted by {@link ucastToExpressionNode}. Covers
 * the two shapes {@link rulesToAST} can return: leaf {@link
 * FieldConditionLike} nodes (e.g. `authorId == 1`) and compound {@link
 * CompoundConditionLike} nodes (`and` / `or` / `not`). `DocumentCondition`
 * (whole-row predicates) is not in scope — CASL's default MongoDB AST
 * builder doesn't emit them for simple conditions, and the set of
 * operators they can carry is unbounded.
 */
export type UcastCondition = FieldConditionLike | CompoundConditionLike

/**
 * Translate a ucast condition tree (the return value of CASL's
 * `rulesToAST(ability, action, subject)` minus the null case) into a
 * Sumak {@link ExpressionNode} suitable for passing into
 * `SelectBuilder.where` / `caslAuthz`'s WHERE injection.
 *
 * The converter is a pure function — no I/O, no schema lookup, no
 * dialect. It:
 *   - maps ucast leaf operators to Sumak binary / unary ops,
 *   - wraps every right-hand-side in a {@link param} node so values
 *     travel through sumak's parameterization (never inlined into
 *     SQL),
 *   - preserves ucast operator names in the generated SQL (an
 *     `eq` becomes `=`, not `==`),
 *   - rejects unsupported operators eagerly via {@link
 *     UnsupportedCaslOperatorError}.
 *
 * `rulesToAST` returning `null` (action not permitted) is the caller's
 * to handle — see the `caslToSumakWhere` / `caslAuthz` wrappers in
 * `src/casl/where.ts` and `src/plugin/casl.ts`.
 *
 * Param-index threading: binary ops allocate `param(0, value)` here.
 * Sumak's printers re-number parameters when they walk the final AST,
 * so the `0` we pass is a placeholder, not a collision. This matches
 * how `multi-tenant.ts` and every other built-in plugin emit params.
 */
export function ucastToExpressionNode(condition: UcastCondition): ExpressionNode {
  return convert(condition, "root")
}

function convert(cond: UcastCondition, context: string): ExpressionNode {
  // Compound conditions carry an array in `value`; leaf conditions
  // carry a scalar or array literal. The discriminator is the shape of
  // `value` combined with the presence of `field` — we can't rely on
  // `instanceof` because (see docstring) we also accept plain objects.
  if (isCompound(cond)) return convertCompound(cond, context)
  if (isField(cond)) return convertField(cond, context)
  throw new UnsupportedCaslOperatorError(
    (cond as { operator?: string }).operator ?? "<unknown>",
    `${context}: neither a FieldCondition nor a CompoundCondition`,
  )
}

function isField(c: UcastCondition): c is FieldConditionLike {
  return typeof (c as FieldConditionLike).field === "string"
}

function isCompound(c: UcastCondition): c is CompoundConditionLike {
  // `Array.isArray(c.value)` is the structural discriminator — ucast's
  // CompoundCondition extends DocumentCondition<T[]>, so `value` is
  // always an array for `and` / `or` / `not`. FieldConditions that use
  // array operators (`in`, `nin`) also carry arrays in `value`, but
  // they have a `field` property too, so `isField` catches them first.
  return Array.isArray((c as CompoundConditionLike).value) && !("field" in c)
}

function convertCompound(cond: CompoundConditionLike, context: string): ExpressionNode {
  const op = cond.operator
  const children = cond.value
  switch (op) {
    case "and": {
      if (children.length === 0) {
        // An empty `and` is a no-op (matches everything). CASL normally
        // wouldn't emit this, but we handle it defensively — `TRUE`
        // ANDs harmlessly into an outer WHERE.
        return { type: "literal", value: true }
      }
      return children
        .slice(1)
        .reduce<ExpressionNode>(
          (acc, c, i) => and(acc, convert(c, `${context}.and[${i + 1}]`)),
          convert(children[0]!, `${context}.and[0]`),
        )
    }
    case "or": {
      if (children.length === 0) {
        // Empty `or` matches nothing — equivalent to FALSE.
        return { type: "literal", value: false }
      }
      return children
        .slice(1)
        .reduce<ExpressionNode>(
          (acc, c, i) => or(acc, convert(c, `${context}.or[${i + 1}]`)),
          convert(children[0]!, `${context}.or[0]`),
        )
    }
    case "not": {
      if (children.length !== 1) {
        throw new UnsupportedCaslOperatorError(
          "not",
          `${context}: NOT must have exactly one child, got ${children.length}`,
        )
      }
      return not(convert(children[0]!, `${context}.not`))
    }
    default:
      throw new UnsupportedCaslOperatorError(op, `${context} (compound)`)
  }
}

function convertField(cond: FieldConditionLike, context: string): ExpressionNode {
  const { operator: op, field, value } = cond
  const columnRef = col(field)
  const here = `${context}.${field}`

  switch (op) {
    case "eq":
      // `eq` with null → `IS NULL`. SQL's `= NULL` always evaluates to
      // UNKNOWN, so callers who wrote `{ deletedAt: null }` in a CASL
      // rule want row-null-check semantics, not three-valued comparison.
      if (value === null) return isNull(columnRef, false)
      return eq(columnRef, param(0, value))
    case "ne":
      // Symmetric to `eq`: `!= null` → `IS NOT NULL`.
      if (value === null) return isNull(columnRef, true)
      return neq(columnRef, param(0, value))
    case "gt":
      return gt(columnRef, param(0, value))
    case "gte":
      return gte(columnRef, param(0, value))
    case "lt":
      return lt(columnRef, param(0, value))
    case "lte":
      return lte(columnRef, param(0, value))
    case "in": {
      const list = expectArray(value, here, "in")
      if (list.length === 0) {
        // Empty IN matches nothing. Returning `FALSE` keeps the
        // generated SQL valid across dialects — `col IN ()` is a
        // parse error in some engines.
        return { type: "literal", value: false }
      }
      return inList(
        columnRef,
        list.map((v) => param(0, v)),
        false,
      )
    }
    case "nin": {
      const list = expectArray(value, here, "nin")
      if (list.length === 0) {
        // Empty NIN matches everything.
        return { type: "literal", value: true }
      }
      return inList(
        columnRef,
        list.map((v) => param(0, v)),
        true,
      )
    }
    // `not` at the field level is rare but legal — ucast can emit
    // `{ operator: "not", field, value: <Condition> }` in theory. CASL's
    // default MongoDB AST builder routes field-scoped negation through
    // the compound `not` instead, so we don't support the field-level
    // variant — if a caller runs into it the error points them at the
    // normalized shape.
    case "regex":
    case "exists":
    case "elemMatch":
    case "all":
    case "size":
      throw new UnsupportedCaslOperatorError(op, here)
    default:
      // Unknown operator. We could try `binOp(op.toUpperCase(), …)` to
      // pass it through, but that risks emitting nonsense SQL for
      // user-added ucast operators we don't know how to parenthesize
      // or parameterize. Fail loud.
      throw new UnsupportedCaslOperatorError(op, here)
  }
}

function expectArray(value: unknown, context: string, op: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new UnsupportedCaslOperatorError(
      op,
      `${context}: "${op}" expects an array value, got ${typeof value}`,
    )
  }
  return value
}

// Re-export the `binOp` helper so tests that want to build custom
// expressions without reaching into the AST module can do so via the
// casl namespace. Harmless for callers who don't need it.
export { binOp }
