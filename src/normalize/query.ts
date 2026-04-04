import type { ASTNode, DeleteNode, SelectNode, UpdateNode } from "../ast/nodes.ts"
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
    default:
      return node
  }
}

function normalizeSelect(node: SelectNode, opts: Required<NormalizeOptions>): SelectNode {
  let result = { ...node }

  // Normalize WHERE
  if (result.where) {
    const w = normalizeExpression(result.where, opts)
    result = { ...result, where: w.type === "literal" && w.value === true ? undefined : w }
  }

  // Normalize HAVING
  if (result.having) {
    const h = normalizeExpression(result.having, opts)
    result = { ...result, having: h.type === "literal" && h.value === true ? undefined : h }
  }

  // Normalize JOIN ON conditions
  if (result.joins.length > 0) {
    result = {
      ...result,
      joins: result.joins.map((j) => {
        if (!j.on) return j
        return { ...j, on: normalizeExpression(j.on, opts) }
      }),
    }
  }

  // Normalize set operation queries recursively
  if (result.setOp) {
    const normalizedSetQuery = normalizeSelect(result.setOp.query, opts)
    result = { ...result, setOp: { ...result.setOp, query: normalizedSetQuery } }
  }

  // Normalize CTE queries recursively
  if (result.ctes.length > 0) {
    result = {
      ...result,
      ctes: result.ctes.map((cte) => ({
        ...cte,
        query: normalizeSelect(cte.query, opts),
      })),
    }
  }

  return result
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
