import type { ASTNode, BinaryOpNode, ExpressionNode, JoinNode, SelectNode } from "../ast/nodes.ts"
import type { RewriteRule } from "./types.ts"

/**
 * Predicate pushdown: push WHERE conditions into JOIN ON when they
 * reference only columns from one side of the join.
 *
 * Before: `SELECT ... FROM a JOIN b ON a.id = b.a_id WHERE b.active = true`
 * After:  `SELECT ... FROM a JOIN b ON a.id = b.a_id AND b.active = true`
 *
 * This helps the database optimizer by reducing the join's input set.
 */
export const predicatePushdown: RewriteRule = {
  name: "predicate-pushdown",

  match(node: ASTNode): boolean {
    if (node.type !== "select") return false
    const s = node as SelectNode
    return s.joins.length > 0 && s.where !== undefined
  },

  apply(node: ASTNode): ASTNode {
    const s = node as SelectNode
    if (!s.where) return node

    const whereParts = flattenAnd(s.where)
    const remaining: ExpressionNode[] = []
    const joins = [...s.joins]

    for (const pred of whereParts) {
      const tables = extractTableRefs(pred)
      let pushed = false

      // Try to push into a join whose table matches all refs in the predicate
      for (let i = 0; i < joins.length; i++) {
        const join = joins[i]
        const joinTable =
          join.table.type === "table_ref" ? (join.table.alias ?? join.table.name) : join.table.alias

        if (joinTable && tables.size === 1 && tables.has(joinTable)) {
          joins[i] = {
            ...join,
            on: join.on ? { type: "binary_op", op: "AND", left: join.on, right: pred } : pred,
          } as JoinNode
          pushed = true
          break
        }
      }

      if (!pushed) {
        remaining.push(pred)
      }
    }

    const newWhere =
      remaining.length > 0
        ? remaining.reduce((acc: ExpressionNode, p) => ({
            type: "binary_op",
            op: "AND",
            left: acc,
            right: p,
          }))
        : undefined

    return { ...s, joins, where: newWhere }
  },
}

/**
 * Remove redundant subquery wrapping when a subquery in FROM
 * is a simple SELECT * with no additional clauses.
 *
 * Before: `SELECT * FROM (SELECT * FROM users) AS u`
 * After:  `SELECT * FROM users`
 */
export const subqueryFlattening: RewriteRule = {
  name: "subquery-flattening",

  match(node: ASTNode): boolean {
    if (node.type !== "select") return false
    const s = node as SelectNode
    if (!s.from || s.from.type !== "subquery") return false
    const inner = s.from.query
    // Only flatten when the inner FROM is a plain table. Flattening a
    // nested subquery or graph_table would either lose the outer alias
    // or require rewriting GRAPH_TABLE semantics — not worth the
    // complexity for a rule that just peels trivial wrappers.
    if (!inner.from || inner.from.type !== "table_ref") return false
    return (
      inner.joins.length === 0 &&
      !inner.where &&
      !inner.having &&
      inner.groupBy.length === 0 &&
      !inner.limit &&
      !inner.offset &&
      !inner.setOp &&
      inner.ctes.length === 0 &&
      !inner.distinct &&
      isSelectStar(inner)
    )
  },

  apply(node: ASTNode): ASTNode {
    const s = node as SelectNode
    if (!s.from || s.from.type !== "subquery") return node
    const inner = s.from.query
    if (!inner.from || inner.from.type !== "table_ref") return node
    // Preserve the outer subquery alias — dropping it would unbind any
    // column references qualified by the outer name. `SELECT u.name FROM
    // (SELECT * FROM users) AS u` should flatten to `SELECT u.name FROM
    // users AS u`, not `SELECT u.name FROM users`.
    if (s.from.alias) {
      return { ...s, from: { ...inner.from, alias: s.from.alias } }
    }
    return { ...s, from: inner.from }
  },
}

/**
 * Merge consecutive WHERE conditions that are just literal true.
 * After normalization, this removes vestigial `WHERE true` from plugins.
 */
export const removeWhereTrue: RewriteRule = {
  name: "remove-where-true",

  match(node: ASTNode): boolean {
    if (node.type === "select" || node.type === "update" || node.type === "delete") {
      const n = node as { where?: ExpressionNode }
      return n.where?.type === "literal" && n.where.value === true
    }
    return false
  },

  apply(node: ASTNode): ASTNode {
    return { ...node, where: undefined } as ASTNode
  },
}

/**
 * Convert `COUNT(*)` in SELECT with only one table and no GROUP BY
 * to use the table name for clarity (optional cosmetic rule).
 */
export const mergeConsecutiveLimits: RewriteRule = {
  name: "merge-consecutive-limits",

  match(node: ASTNode): boolean {
    if (node.type !== "select") return false
    const s = node as SelectNode
    // Check if this is a subquery wrapping another SELECT with a limit,
    // and the outer also has a limit
    if (!s.from || s.from.type !== "subquery" || !s.limit) return false
    return s.from.query.limit !== undefined
  },

  apply(node: ASTNode): ASTNode {
    // Keep the outer (more restrictive) limit — the database will apply both anyway.
    // This rule just flags the pattern; actual merging depends on semantics.
    return node
  },
}

/** All built-in optimization rules. */
export const BUILTIN_RULES: RewriteRule[] = [predicatePushdown, subqueryFlattening, removeWhereTrue]

// ── Helpers ──

function flattenAnd(expr: ExpressionNode): ExpressionNode[] {
  if (expr.type === "binary_op" && (expr as BinaryOpNode).op === "AND") {
    const b = expr as BinaryOpNode
    return [...flattenAnd(b.left), ...flattenAnd(b.right)]
  }
  return [expr]
}

function extractTableRefs(expr: ExpressionNode): Set<string> {
  const refs = new Set<string>()
  collectTableRefs(expr, refs)
  return refs
}

function collectTableRefs(expr: ExpressionNode, refs: Set<string>): void {
  switch (expr.type) {
    case "column_ref":
      if (expr.table) refs.add(expr.table)
      break
    case "binary_op":
      collectTableRefs(expr.left, refs)
      collectTableRefs(expr.right, refs)
      break
    case "unary_op":
      collectTableRefs(expr.operand, refs)
      break
    case "is_null":
    case "cast":
      collectTableRefs(expr.expr, refs)
      break
    case "between":
      collectTableRefs(expr.expr, refs)
      collectTableRefs(expr.low, refs)
      collectTableRefs(expr.high, refs)
      break
    case "in":
      collectTableRefs(expr.expr, refs)
      if (Array.isArray(expr.values)) {
        for (const v of expr.values) collectTableRefs(v, refs)
      }
      break
    case "function_call":
      for (const a of expr.args) collectTableRefs(a, refs)
      break
  }
}

function isSelectStar(node: SelectNode): boolean {
  return node.columns.length === 1 && node.columns[0].type === "star" && !node.columns[0].table
}
