import type {
  ASTNode,
  DeleteNode,
  ExpressionNode,
  MergeNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { assertNever } from "../errors.ts"
import { normalizeExpression } from "./expression.ts"
import type { NormalizeOptions } from "./types.ts"
import { DEFAULT_NORMALIZE_OPTIONS } from "./types.ts"

/**
 * Normalize a full query AST node.
 *
 * Applies NbE normalization to all expression-bearing parts:
 * - WHERE clauses (SELECT, UPDATE, DELETE)
 * - HAVING clauses (SELECT)
 * - JOIN ON conditions
 * - ON CONFLICT WHERE (INSERT)
 *
 * Leaves non-expression parts (table refs, column lists, ORDER BY) unchanged.
 */
export function normalizeQuery(node: ASTNode, opts?: NormalizeOptions): ASTNode {
  const o = { ...DEFAULT_NORMALIZE_OPTIONS, ...opts }
  switch (node.type) {
    case "select":
      return normalizeSelect(node, o)
    case "update":
      return normalizeUpdate(node, o)
    case "delete":
      return normalizeDelete(node, o)
    case "insert":
      return normalizeInsert(node, o)
    case "merge":
      return normalizeMerge(node, o)
    case "explain": {
      const inner = normalizeQuery(node.statement, opts) as typeof node.statement
      return inner === node.statement ? node : { ...node, statement: inner }
    }
    // Bare ExpressionNode: normalize directly.
    case "column_ref":
    case "literal":
    case "binary_op":
    case "unary_op":
    case "function_call":
    case "param":
    case "raw":
    case "subquery":
    case "between":
    case "in":
    case "is_null":
    case "case":
    case "cast":
    case "exists":
    case "star":
    case "json_access":
    case "array_expr":
    case "window_function":
    case "aliased_expr":
    case "full_text_search":
    case "tuple":
    case "quantified":
      return normalizeExpression(node as ExpressionNode, o)
    default:
      return assertNever(node, "normalizeQuery")
  }
}

function normalizeMerge(node: MergeNode, opts: Required<NormalizeOptions>): MergeNode {
  return {
    ...node,
    on: normalizeExpression(node.on, opts),
    whens: node.whens.map((w) => {
      if (w.type === "matched") {
        return {
          ...w,
          condition: w.condition ? normalizeExpression(w.condition, opts) : undefined,
          set: w.set?.map((s) => ({ ...s, value: normalizeExpression(s.value, opts) })),
        }
      }
      return {
        ...w,
        condition: w.condition ? normalizeExpression(w.condition, opts) : undefined,
        values: w.values.map((v) => normalizeExpression(v, opts)),
      }
    }),
  }
}

function normalizeSelect(node: SelectNode, opts: Required<NormalizeOptions>): SelectNode {
  // Compute each normalized piece independently, then copy the node only
  // if something actually changed. Preserves object identity on no-op —
  // EXPLAIN passthrough and caller-side `toBe` comparisons rely on this.
  const newWhere = node.where ? normalizeExpression(node.where, opts) : undefined
  const finalWhere =
    newWhere && newWhere.type === "literal" && newWhere.value === true ? undefined : newWhere
  const whereChanged = finalWhere !== node.where

  const newHaving = node.having ? normalizeExpression(node.having, opts) : undefined
  const finalHaving =
    newHaving && newHaving.type === "literal" && newHaving.value === true ? undefined : newHaving
  const havingChanged = finalHaving !== node.having

  let joinsChanged = false
  const newJoins = node.joins.map((j) => {
    if (!j.on) return j
    const on = normalizeExpression(j.on, opts)
    if (on !== j.on) {
      joinsChanged = true
      return { ...j, on }
    }
    return j
  })

  let setOpChanged = false
  let newSetOp = node.setOp
  if (node.setOp) {
    const q = normalizeSelect(node.setOp.query, opts)
    if (q !== node.setOp.query) {
      setOpChanged = true
      newSetOp = { ...node.setOp, query: q }
    }
  }

  let ctesChanged = false
  const newCtes = node.ctes.map((cte) => {
    const q = normalizeSelect(cte.query, opts)
    if (q !== cte.query) {
      ctesChanged = true
      return { ...cte, query: q }
    }
    return cte
  })

  if (!whereChanged && !havingChanged && !joinsChanged && !setOpChanged && !ctesChanged) {
    return node
  }
  return {
    ...node,
    where: finalWhere,
    having: finalHaving,
    joins: joinsChanged ? newJoins : node.joins,
    setOp: setOpChanged ? newSetOp : node.setOp,
    ctes: ctesChanged ? newCtes : node.ctes,
  }
}

function normalizeUpdate(node: UpdateNode, opts: Required<NormalizeOptions>): UpdateNode {
  let result = { ...node }

  if (result.where) {
    const w = normalizeExpression(result.where, opts)
    result = { ...result, where: w.type === "literal" && w.value === true ? undefined : w }
  }

  if (result.joins.length > 0) {
    result = {
      ...result,
      joins: result.joins.map((j) => {
        if (!j.on) return j
        return { ...j, on: normalizeExpression(j.on, opts) }
      }),
    }
  }

  return result
}

function normalizeDelete(node: DeleteNode, opts: Required<NormalizeOptions>): DeleteNode {
  let result = { ...node }

  if (result.where) {
    const w = normalizeExpression(result.where, opts)
    result = { ...result, where: w.type === "literal" && w.value === true ? undefined : w }
  }

  if (result.joins.length > 0) {
    result = {
      ...result,
      joins: result.joins.map((j) => {
        if (!j.on) return j
        return { ...j, on: normalizeExpression(j.on, opts) }
      }),
    }
  }

  return result
}

function normalizeInsert(
  node: import("../ast/nodes.ts").InsertNode,
  opts: Required<NormalizeOptions>,
): import("../ast/nodes.ts").InsertNode {
  if (!node.onConflict?.where) return node

  return {
    ...node,
    onConflict: {
      ...node.onConflict,
      where: normalizeExpression(node.onConflict.where, opts),
    },
  }
}
