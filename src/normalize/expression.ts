import type {
  BinaryOpNode,
  ExpressionNode,
  LiteralNode,
  SelectNode,
  UnaryOpNode,
} from "../ast/nodes.ts"
import { mapPreserve } from "../ast/walker.ts"
import { assertNever } from "../errors.ts"
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
// Run the simplify/fold/flatten/dedupe sweep until it stops
// rewriting. Capped iteration count over `while (changed)` so a
// future rewrite-rule bug that loops between two shapes can't take
// user-facing compile down with it. Identity is checked via `===`;
// each sub-pass + `recurse` now preserves identity on no-op cases,
// so the typical query exits after one body iteration. Empirically
// (`test/fuzz/properties.test.ts`) every shape the generator
// produces settles in ≤ 2 sweeps.
const NORMALIZE_FIXPOINT_PASSES = 6

export function normalizeExpression(expr: ExpressionNode, opts?: NormalizeOptions): ExpressionNode {
  const o = { ...DEFAULT_NORMALIZE_OPTIONS, ...opts }
  let result = expr

  for (let i = 0; i < NORMALIZE_FIXPOINT_PASSES; i++) {
    const previous = result
    if (o.simplifyNegation) result = simplifyNegation(result)
    if (o.foldConstants) result = foldConstants(result)
    if (o.simplifyTautologies) result = simplifyTautologies(result)
    if (o.flattenLogical) result = flattenLogical(result)
    if (o.deduplicatePredicates) result = deduplicatePredicates(result)
    if (result === previous) break
  }

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
 * True when `node` is a left-leaning chain of `op` binary_ops — every
 * AND/OR sits in `.left` and the `.right` is a non-`op` leaf. Both
 * `and()` / `or()` builders and chained `.where(...).where(...)`
 * produce this canonical shape, so the check below short-circuits the
 * common no-op path.
 */
function isLeftLeaningChain(node: ExpressionNode, op: "AND" | "OR"): boolean {
  let cur = node
  while (cur.type === "binary_op" && (cur as BinaryOpNode).op === op) {
    const bo = cur as BinaryOpNode
    if (bo.right.type === "binary_op" && (bo.right as BinaryOpNode).op === op) {
      return false
    }
    cur = bo.left
  }
  return true
}

/**
 * Flatten nested AND/OR into a flat structure.
 * `(a AND (b AND c))` → `(a AND b AND c)` (left-associative chain)
 *
 * Identity preservation: when the input is already a left-leaning
 * chain of `op` and no inner recursion rewrites a part, we return the
 * original node verbatim. Downstream normalize passes use the
 * `result === expr` shortcut to skip work; without identity
 * preservation here, every pass would reallocate the full AND tree
 * even when nothing changed.
 */
export function flattenLogical(expr: ExpressionNode): ExpressionNode {
  if (expr.type !== "binary_op") return recurse(expr, flattenLogical)

  const e = expr as BinaryOpNode
  if (e.op === "AND" || e.op === "OR") {
    const op = e.op
    const parts = op === "AND" ? flattenAnd(e) : flattenOr(e)
    let anyChanged = false
    for (let i = 0; i < parts.length; i++) {
      const np = flattenLogical(parts[i]!)
      if (np !== parts[i]) {
        anyChanged = true
        parts[i] = np
      }
    }
    if (!anyChanged && isLeftLeaningChain(e, op)) {
      return e
    }
    return parts.reduce((acc: ExpressionNode, p) => ({
      type: "binary_op",
      op,
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
  // Nothing dedup'd — return input verbatim so a `result === previous`
  // check upstream short-circuits the no-op case.
  if (unique.length === parts.length) return expr
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
    return left === e.left && right === e.right ? e : { ...e, left, right }
  }

  if (e.op === "OR") {
    // x OR true → true
    if (isTrue(left) || isTrue(right)) return { type: "literal", value: true }
    // x OR false → x
    if (isFalse(left)) return right
    if (isFalse(right)) return left
    return left === e.left && right === e.right ? e : { ...e, left, right }
  }

  return left === e.left && right === e.right ? e : { ...e, left, right }
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
      return inner === u.operand ? u : { ...u, operand: inner }
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
    // Refuse to fold `||` at normalize time. Dialect semantics diverge:
    //   pg / sqlite: string concat (`'a' || 'b' → 'ab'`).
    //   mysql (default sql_mode, no PIPES_AS_CONCAT): logical OR
    //     (`'0' || '0' → 0`, string-to-number coerced).
    //   mssql: `||` is not an operator at all.
    // The normalizer has no dialect context, so folding here would
    // silently change meaning on MySQL and hide the parse error the
    // driver would otherwise surface on MSSQL.
  }

  // Normalize comparison: literal on right (1 = x → x = 1)
  if (isComparisonOp(e.op) && left.type === "literal" && right.type !== "literal") {
    return { type: "binary_op", op: flipComparison(e.op), left: right, right: left }
  }

  return left === e.left && right === e.right ? e : { ...e, left, right }
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
    case "%": {
      // SQL integer division truncates: `5 / 2 = 2` on pg / mysql /
      // sqlite / mssql. JS's `/` is float division → `5 / 2 = 2.5`.
      // Folding `5/2 → 2.5` silently changes the row set if the result
      // is compared to an integer column. Refuse to fold `/` and `%`
      // when both operands are integers; float/float is safe because
      // SQL already does float division there.
      if (r === 0) return undefined
      if (Number.isInteger(l) && Number.isInteger(r)) return undefined
      return op === "/" ? l / r : l % r
    }
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

let paramOccurrence = 0

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
      // Unique per occurrence, never the value. Two parameters must never
      // dedupe: the emitted SQL would depend on what the caller passed, which
      // costs the database its prepared-statement plan and makes one call site
      // emit several different texts.
      return `param:#${paramOccurrence++}`
    case "binary_op":
      return `bin:${expr.op}:${exprFingerprint(expr.left)}:${exprFingerprint(expr.right)}`
    case "unary_op":
      return `un:${expr.op}:${exprFingerprint(expr.operand)}`
    case "is_null":
      return `isnull:${expr.negated}:${exprFingerprint(expr.expr)}`
    case "is_json":
      return `isjson:${expr.negated}:${expr.kind ?? ""}:${exprFingerprint(expr.expr)}`
    case "between":
      return `between:${expr.negated}:${exprFingerprint(expr.expr)}:${exprFingerprint(expr.low)}:${exprFingerprint(expr.high)}`
    case "in":
      if (Array.isArray(expr.values)) {
        const values = expr.values
        // Arity plus one occurrence stamp stands in for N identical
        // `param:#n` fingerprints, so a 100-value IN(...) costs one counter
        // bump instead of 100 fingerprint calls.
        let allParams = true
        for (let i = 0; i < values.length; i++) {
          if (values[i]!.type !== "param") {
            allParams = false
            break
          }
        }
        if (allParams) {
          return `in:${expr.negated}:${exprFingerprint(expr.expr)}:p${values.length}#${paramOccurrence++}`
        }
        return `in:${expr.negated}:${exprFingerprint(expr.expr)}:[${values.map(exprFingerprint).join(",")}]`
      }
      return `in:${expr.negated}:${exprFingerprint(expr.expr)}:subq`
    case "function_call":
      return `fn:${expr.name}:${expr.distinct ?? false}:[${expr.args.map(exprFingerprint).join(",")}]:rt=${expr.returningType ?? ""}`
    case "cast":
      return `cast:${expr.dataType}:${exprFingerprint(expr.expr)}`
    case "case":
      return `case:${expr.operand ? exprFingerprint(expr.operand) : ""}:${expr.whens
        .map((w) => `${exprFingerprint(w.condition)}=>${exprFingerprint(w.result)}`)
        .join(",")}:${expr.else_ ? exprFingerprint(expr.else_) : ""}`
    case "exists":
      return `exists:${expr.negated}:${selectFingerprint(expr.query)}`
    case "star":
      return `star:${expr.table ?? ""}`
    case "raw":
      return `raw:${expr.sql}`
    case "subquery":
      return `subq:${expr.alias ?? ""}:${selectFingerprint(expr.query)}`
    case "json_access":
      return `json:${expr.operator}:${expr.path}:${exprFingerprint(expr.expr)}`
    case "array_expr":
      return `arr:[${expr.elements.map(exprFingerprint).join(",")}]`
    case "tuple":
      return `tup:[${expr.elements.map(exprFingerprint).join(",")}]`
    case "aliased_expr":
      return `alias:${expr.alias}:${exprFingerprint(expr.expr)}`
    case "full_text_search":
      return `fts:${expr.mode ?? ""}:${expr.language ?? ""}:${expr.columns.map(exprFingerprint).join(",")}:${exprFingerprint(expr.query)}`
    case "window_function":
      return `win:${exprFingerprint(expr.fn)}:${expr.partitionBy.map(exprFingerprint).join(",")}:${expr.orderBy.map((o) => `${exprFingerprint(o.expr)}:${o.direction}`).join(",")}`
    case "quantified":
      return `q:${expr.quantifier}:${exprFingerprint(expr.operand)}`
    case "grouping":
      return `grp:${expr.kind}:${expr.sets.map((s) => s.map(exprFingerprint).join(",")).join(";")}`
    case "date_interval":
      // Include amount + unit in the fingerprint so two intervals on the
      // same expression but with different magnitudes / units dedup as
      // distinct predicates (e.g. `created_at + INTERVAL '1 day'` and
      // `created_at + INTERVAL '7 days'`).
      return `dint:${expr.amount}:${expr.unit}:${exprFingerprint(expr.expr)}`
    default:
      return assertNever(expr, "exprFingerprint")
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
  // Identity preservation: every case returns `expr` verbatim when no
  // child was rewritten. The fixpoint loop in `normalizeExpression`
  // (and any caller that compares results with `===`) relies on this
  // — without it, every sweep reallocates the entire subtree even
  // when nothing changed, which is exactly what burned PR #102's
  // perf regression.
  switch (expr.type) {
    case "binary_op": {
      const left = transform(expr.left)
      const right = transform(expr.right)
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right }
    }
    case "unary_op": {
      const operand = transform(expr.operand)
      return operand === expr.operand ? expr : { ...expr, operand }
    }
    case "is_null": {
      const inner = transform(expr.expr)
      return inner === expr.expr ? expr : { ...expr, expr: inner }
    }
    case "is_json": {
      const inner = transform(expr.expr)
      return inner === expr.expr ? expr : { ...expr, expr: inner }
    }
    case "between": {
      const e = transform(expr.expr)
      const low = transform(expr.low)
      const high = transform(expr.high)
      return e === expr.expr && low === expr.low && high === expr.high
        ? expr
        : { ...expr, expr: e, low, high }
    }
    case "in":
      if (Array.isArray(expr.values)) {
        const values = expr.values
        // Fast path: when every value is a leaf ParamNode (the shape
        // produced by `col.in([1,2,3,…])`), none of the normalize
        // passes can rewrite it — params have no children for
        // simplifyNegation / foldConstants / etc. to recurse into.
        // Skipping the `.map(transform)` for the 100-value case avoids
        // ~500 wasted transform calls per query (5 normalize passes ×
        // N values), the dominant cost for large IN-lists.
        let allParams = true
        for (let i = 0; i < values.length; i++) {
          if (values[i]!.type !== "param") {
            allParams = false
            break
          }
        }
        const transformedExpr = transform(expr.expr)
        if (allParams) {
          return transformedExpr === expr.expr ? expr : { ...expr, expr: transformedExpr }
        }
        const newValues = mapPreserve(values, transform)
        return transformedExpr === expr.expr && newValues === values
          ? expr
          : { ...expr, expr: transformedExpr, values: newValues }
      }
      // Subquery operand. Walking into a SelectNode here would require
      // recursing through normalizeQuery, which the per-pass
      // simplifiers don't do — keep them out and let the higher-level
      // normalizeSelect handle the subquery's body.
      {
        const inner = transform(expr.expr)
        return inner === expr.expr ? expr : { ...expr, expr: inner }
      }
    case "cast": {
      const inner = transform(expr.expr)
      return inner === expr.expr ? expr : { ...expr, expr: inner }
    }
    case "function_call": {
      const args = mapPreserve(expr.args, transform)
      const filter = expr.filter ? transform(expr.filter) : undefined
      return args === expr.args && filter === expr.filter ? expr : { ...expr, args, filter }
    }
    case "case": {
      const operand = expr.operand ? transform(expr.operand) : undefined
      const whens = mapPreserve(expr.whens, (w) => {
        const condition = transform(w.condition)
        const result = transform(w.result)
        return condition === w.condition && result === w.result ? w : { condition, result }
      })
      const else_ = expr.else_ ? transform(expr.else_) : undefined
      return operand === expr.operand && whens === expr.whens && else_ === expr.else_
        ? expr
        : { ...expr, operand, whens, else_ }
    }
    case "aliased_expr": {
      const inner = transform(expr.expr)
      return inner === expr.expr ? expr : { ...expr, expr: inner }
    }
    case "json_access": {
      const inner = transform(expr.expr)
      return inner === expr.expr ? expr : { ...expr, expr: inner }
    }
    case "tuple": {
      const elements = mapPreserve(expr.elements, transform)
      return elements === expr.elements ? expr : { ...expr, elements }
    }
    case "array_expr": {
      const elements = mapPreserve(expr.elements, transform)
      return elements === expr.elements ? expr : { ...expr, elements }
    }
    case "full_text_search": {
      const columns = mapPreserve(expr.columns, transform)
      const query = transform(expr.query)
      return columns === expr.columns && query === expr.query ? expr : { ...expr, columns, query }
    }
    case "window_function": {
      const fn = transform(expr.fn) as typeof expr.fn
      const partitionBy = mapPreserve(expr.partitionBy, transform)
      const orderBy = mapPreserve(expr.orderBy, (o) => {
        const e = transform(o.expr)
        return e === o.expr ? o : { ...o, expr: e }
      })
      return fn === expr.fn && partitionBy === expr.partitionBy && orderBy === expr.orderBy
        ? expr
        : { ...expr, fn, partitionBy, orderBy }
    }
    case "quantified": {
      // Operand is one of subquery | array_expr | param | raw — walk
      // it so the inner columns / params go through the same
      // simplification passes every other expression sees.
      const operand = transform(expr.operand) as typeof expr.operand
      return operand === expr.operand ? expr : { ...expr, operand }
    }
    case "grouping": {
      const sets = mapPreserve(expr.sets, (s) => mapPreserve(s, transform))
      return sets === expr.sets ? expr : { ...expr, sets }
    }
    case "date_interval": {
      // Only `expr` carries a child ExpressionNode; `amount` / `unit`
      // are scalars and don't participate in normalization.
      const inner = transform(expr.expr)
      return inner === expr.expr ? expr : { ...expr, expr: inner }
    }
    // Terminal / opaque nodes — no child expressions to walk.
    case "column_ref":
    case "literal":
    case "param":
    case "raw":
    case "subquery":
    case "exists":
    case "star":
      return expr
    default:
      return assertNever(expr, "normalize.recurse")
  }
}
