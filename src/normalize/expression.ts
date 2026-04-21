import type {
  BinaryOpNode,
  ExpressionNode,
  LiteralNode,
  SelectNode,
  UnaryOpNode,
} from "../ast/nodes.ts"
import type { CNF, NormalizeOptions } from "./types.ts"
import { DEFAULT_NORMALIZE_OPTIONS } from "./types.ts"

/**
 * Normalize an expression node using NbE (Normalization by Evaluation).
 *
 * Pipeline: Expression → evaluate (semantic domain) → reify (canonical AST)
 *
 * Transformations:
 * - Flatten nested AND/OR
 * - Remove duplicate predicates
 * - Simplify tautologies: `x AND true → x`, `x OR false → x`
 * - Simplify contradictions: `x AND false → false`, `x OR true → true`
 * - Fold constants: `1 + 2 → 3`
 * - Simplify negation: `NOT NOT x → x`, `NOT true → false`
 * - Normalize comparison direction: `1 = x → x = 1` (literal always on right)
 */
export function normalizeExpression(expr: ExpressionNode, opts?: NormalizeOptions): ExpressionNode {
  const o = { ...DEFAULT_NORMALIZE_OPTIONS, ...opts }
  let result = expr

  if (o.simplifyNegation) result = simplifyNegation(result)
  if (o.foldConstants) result = foldConstants(result)
  if (o.simplifyTautologies) result = simplifyTautologies(result)
  if (o.flattenLogical) result = flattenLogical(result)
  if (o.deduplicatePredicates) result = deduplicatePredicates(result)
  // One more pass for tautologies created by deduplication
  if (o.simplifyTautologies) result = simplifyTautologies(result)

  return result
}

// ── Evaluate: Expression → CNF ──

/**
 * Convert a WHERE expression to Conjunctive Normal Form.
 * Top-level AND, inner OR.
 */
export function toCNF(expr: ExpressionNode): CNF {
  const conjuncts = flattenAnd(expr)
  const clauses = conjuncts.map((c) => flattenOr(c))
  return { clauses }
}

/**
 * Reify a CNF back to an ExpressionNode.
 */
export function fromCNF(cnf: CNF): ExpressionNode | undefined {
  if (cnf.clauses.length === 0) return undefined

  const conjuncts = cnf.clauses.map((disjuncts) => {
    if (disjuncts.length === 0) return undefined
    return disjuncts.reduce((acc: ExpressionNode, d) => ({
      type: "binary_op",
      op: "OR",
      left: acc,
      right: d,
    }))
  })

  const filtered = conjuncts.filter((c): c is ExpressionNode => c !== undefined)
  if (filtered.length === 0) return undefined

  return filtered.reduce((acc: ExpressionNode, c) => ({
    type: "binary_op",
    op: "AND",
    left: acc,
    right: c,
  }))
}

// ── Flatten AND/OR ──

/**
 * Walk a left-skewed AND tree iteratively so deeply nested WHERE
 * clauses (think bulk-generated predicates, 5k+ conditions) don't
 * blow the call stack. Recursive spread would overflow around
 * 10k–15k frames depending on runtime.
 */
function flattenAnd(expr: ExpressionNode): ExpressionNode[] {
  return flattenByOp(expr, "AND")
}

function flattenOr(expr: ExpressionNode): ExpressionNode[] {
  return flattenByOp(expr, "OR")
}

function flattenByOp(expr: ExpressionNode, op: "AND" | "OR"): ExpressionNode[] {
  const out: ExpressionNode[] = []
  const stack: ExpressionNode[] = [expr]
  while (stack.length > 0) {
    const node = stack.pop() as ExpressionNode
    if (node.type === "binary_op" && node.op === op) {
      // Push right first so left is popped first → preserves chain order.
      stack.push(node.right)
      stack.push(node.left)
    } else {
      out.push(node)
    }
  }
  return out
}

/**
 * Flatten nested AND/OR into a flat structure.
 * `(a AND (b AND c))` → `(a AND b AND c)` (left-associative chain)
 */
export function flattenLogical(expr: ExpressionNode): ExpressionNode {
  if (expr.type !== "binary_op") return recurse(expr, flattenLogical)

  const e = expr as BinaryOpNode
  if (e.op === "AND") {
    const parts = flattenAnd(e).map(flattenLogical)
    return parts.reduce((acc: ExpressionNode, p) => ({
      type: "binary_op",
      op: "AND",
      left: acc,
      right: p,
    }))
  }
  if (e.op === "OR") {
    const parts = flattenOr(e).map(flattenLogical)
    return parts.reduce((acc: ExpressionNode, p) => ({
      type: "binary_op",
      op: "OR",
      left: acc,
      right: p,
    }))
  }

  return recurse(expr, flattenLogical)
}

// ── Deduplicate predicates ──

/**
 * Remove duplicate AND clauses.
 * `a = 1 AND b = 2 AND a = 1` → `a = 1 AND b = 2`
 */
export function deduplicatePredicates(expr: ExpressionNode): ExpressionNode {
  if (expr.type !== "binary_op" || (expr as BinaryOpNode).op !== "AND") return expr

  const parts = flattenAnd(expr)
  const seen = new Set<string>()
  const unique: ExpressionNode[] = []

  for (const p of parts) {
    const key = exprFingerprint(p)
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(p)
    }
  }

  if (unique.length === 0) return { type: "literal", value: true }
  return unique.reduce((acc: ExpressionNode, p) => ({
    type: "binary_op",
    op: "AND",
    left: acc,
    right: p,
  }))
}

// ── Simplify tautologies ──

function simplifyTautologies(expr: ExpressionNode): ExpressionNode {
  if (expr.type !== "binary_op") return recurse(expr, simplifyTautologies)

  const e = expr as BinaryOpNode
  const left = simplifyTautologies(e.left)
  const right = simplifyTautologies(e.right)

  if (e.op === "AND") {
    // x AND true → x
    if (isTrue(left)) return right
    if (isTrue(right)) return left
    // x AND false → false
    if (isFalse(left) || isFalse(right)) return { type: "literal", value: false }
    return { ...e, left, right }
  }

  if (e.op === "OR") {
    // x OR true → true
    if (isTrue(left) || isTrue(right)) return { type: "literal", value: true }
    // x OR false → x
    if (isFalse(left)) return right
    if (isFalse(right)) return left
    return { ...e, left, right }
  }

  return { ...e, left, right }
}

// ── Simplify negation ──

function simplifyNegation(expr: ExpressionNode): ExpressionNode {
  if (expr.type === "unary_op") {
    const u = expr as UnaryOpNode
    if (u.op === "NOT") {
      const inner = simplifyNegation(u.operand)
      // NOT NOT x → x
      if (inner.type === "unary_op" && (inner as UnaryOpNode).op === "NOT") {
        return (inner as UnaryOpNode).operand
      }
      // NOT true → false, NOT false → true
      if (isTrue(inner)) return { type: "literal", value: false }
      if (isFalse(inner)) return { type: "literal", value: true }
      // NOT (x IS NULL) → x IS NOT NULL
      if (inner.type === "is_null") {
        return { ...inner, negated: !inner.negated }
      }
      return { ...u, operand: inner }
    }
  }
  return recurse(expr, simplifyNegation)
}

// ── Constant folding ──

function foldConstants(expr: ExpressionNode): ExpressionNode {
  if (expr.type !== "binary_op") return recurse(expr, foldConstants)

  const e = expr as BinaryOpNode
  const left = foldConstants(e.left)
  const right = foldConstants(e.right)

  // Only fold when both sides are numeric literals
  if (left.type === "literal" && right.type === "literal") {
    const lv = (left as LiteralNode).value
    const rv = (right as LiteralNode).value
    if (typeof lv === "number" && typeof rv === "number") {
      const folded = foldNumeric(e.op, lv, rv)
      if (folded !== undefined) return { type: "literal", value: folded }
    }
    // String concatenation
    if (typeof lv === "string" && typeof rv === "string" && e.op === "||") {
      return { type: "literal", value: lv + rv }
    }
  }

  // Normalize comparison: literal on right (1 = x → x = 1)
  if (isComparisonOp(e.op) && left.type === "literal" && right.type !== "literal") {
    return { type: "binary_op", op: flipComparison(e.op), left: right, right: left }
  }

  return { ...e, left, right }
}

function foldNumeric(op: string, l: number, r: number): number | boolean | undefined {
  switch (op) {
    case "+":
      return l + r
    case "-":
      return l - r
    case "*":
      return l * r
    case "/":
      return r !== 0 ? l / r : undefined
    case "%":
      return r !== 0 ? l % r : undefined
    default:
      return undefined
  }
}

function isComparisonOp(op: string): boolean {
  return (
    op === "=" ||
    op === "!=" ||
    op === "<>" ||
    op === "<" ||
    op === ">" ||
    op === "<=" ||
    op === ">="
  )
}

function flipComparison(op: string): string {
  switch (op) {
    case "<":
      return ">"
    case ">":
      return "<"
    case "<=":
      return ">="
    case ">=":
      return "<="
    default:
      return op // =, !=, <> are symmetric
  }
}

// ── Helpers ──

function isTrue(expr: ExpressionNode): boolean {
  return expr.type === "literal" && (expr as LiteralNode).value === true
}

function isFalse(expr: ExpressionNode): boolean {
  return expr.type === "literal" && (expr as LiteralNode).value === false
}

/**
 * Structural fingerprint for deduplication.
 * Produces a canonical string for an expression node.
 */
function exprFingerprint(expr: ExpressionNode): string {
  switch (expr.type) {
    case "column_ref":
      return `col:${expr.table ?? ""}:${expr.column}`
    case "literal":
      return `lit:${String(expr.value)}`
    case "param":
      return `param:${String(expr.value)}`
    case "binary_op":
      return `bin:${expr.op}:${exprFingerprint(expr.left)}:${exprFingerprint(expr.right)}`
    case "unary_op":
      return `un:${expr.op}:${exprFingerprint(expr.operand)}`
    case "is_null":
      return `isnull:${expr.negated}:${exprFingerprint(expr.expr)}`
    case "between":
      return `between:${expr.negated}:${exprFingerprint(expr.expr)}:${exprFingerprint(expr.low)}:${exprFingerprint(expr.high)}`
    case "in":
      if (Array.isArray(expr.values)) {
        return `in:${expr.negated}:${exprFingerprint(expr.expr)}:[${expr.values.map(exprFingerprint).join(",")}]`
      }
      return `in:${expr.negated}:${exprFingerprint(expr.expr)}:subq`
    case "function_call":
      return `fn:${expr.name}:${expr.distinct ?? false}:[${expr.args.map(exprFingerprint).join(",")}]`
    case "cast":
      return `cast:${expr.dataType}:${exprFingerprint(expr.expr)}`
    case "exists":
      return `exists:${expr.negated}:${selectFingerprint(expr.query)}`
    case "star":
      return `star:${expr.table ?? ""}`
    case "raw":
      return `raw:${expr.sql}`
    case "subquery":
      return `subq:${expr.alias ?? ""}:${selectFingerprint(expr.query)}`
    default:
      return `unknown:${expr.type}`
  }
}

/**
 * Shallow-ish structural fingerprint for a SELECT node — enough to
 * distinguish two different subqueries / EXISTS predicates for
 * deduplication. Recurses into WHERE and the table reference; the
 * column/order/group-by lists are folded into a count+types summary
 * so very large subqueries don't blow up fingerprint length.
 */
function selectFingerprint(q: SelectNode): string {
  const from = q.from
    ? q.from.type === "table_ref"
      ? `t:${q.from.name}:${q.from.alias ?? ""}`
      : from_extraKind(q.from)
    : "none"
  const where = q.where ? exprFingerprint(q.where) : "no-where"
  const cols = q.columns.map((c) => c.type).join(",")
  return `sel(${from}|${where}|cols=${cols})`
}

function from_extraKind(from: { type: string }): string {
  return `other:${from.type}`
}

/**
 * Recursively apply a transform to child expressions of any expression node.
 */
function recurse(
  expr: ExpressionNode,
  transform: (e: ExpressionNode) => ExpressionNode,
): ExpressionNode {
  switch (expr.type) {
    case "binary_op":
      return { ...expr, left: transform(expr.left), right: transform(expr.right) }
    case "unary_op":
      return { ...expr, operand: transform(expr.operand) }
    case "is_null":
      return { ...expr, expr: transform(expr.expr) }
    case "between":
      return {
        ...expr,
        expr: transform(expr.expr),
        low: transform(expr.low),
        high: transform(expr.high),
      }
    case "in":
      if (Array.isArray(expr.values)) {
        return { ...expr, expr: transform(expr.expr), values: expr.values.map(transform) }
      }
      return { ...expr, expr: transform(expr.expr) }
    case "cast":
      return { ...expr, expr: transform(expr.expr) }
    case "function_call":
      return { ...expr, args: expr.args.map(transform) }
    case "case":
      return {
        ...expr,
        operand: expr.operand ? transform(expr.operand) : undefined,
        whens: expr.whens.map((w) => ({
          condition: transform(w.condition),
          result: transform(w.result),
        })),
        else_: expr.else_ ? transform(expr.else_) : undefined,
      }
    default:
      return expr
  }
}
