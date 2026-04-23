import type {
  ASTNode,
  ColumnRefNode,
  DeleteNode,
  ExpressionNode,
  InsertNode,
  SelectNode,
  StarNode,
  UpdateNode,
} from "../ast/nodes.ts"
import type { ResultContext } from "./types.ts"

/**
 * Derive a {@link ResultContext} from an AST node.
 *
 * - `table`: the primary target of the statement (FROM / INTO / UPDATE
 *   / DELETE) — the single obvious "this row came from X" answer, used
 *   by enricher plugins that tag rows with `__typename` or similar.
 *
 * - `columnSources`: a best-effort column→table map, built from the
 *   output column list:
 *     • `aliased_expr` wrapping a `column_ref` with a table → output
 *       alias maps to that table.
 *     • bare `column_ref` with a table → column maps to that table.
 *     • `star` (with or without table qualifier) produces nothing
 *       directly (we don't know the row shape without schema info).
 *     • any expression we can't statically resolve is omitted.
 *
 * We deliberately return a partial map — plugins that enrich per-row
 * should default to `table` for any output field not in `columnSources`.
 */
export function deriveResultContext(node: ASTNode): ResultContext {
  switch (node.type) {
    case "select":
      return selectContext(node)
    case "insert":
      return dmlContext(node, node.returning)
    case "update":
      return dmlContext(node, node.returning)
    case "delete":
      return dmlContext(node, node.returning)
    case "explain":
      // The interesting context lives on the inner statement.
      return deriveResultContext(node.statement)
    default:
      return { node }
  }
}

function selectContext(node: SelectNode): ResultContext {
  const table =
    node.from?.type === "table_ref"
      ? node.from.name
      : node.from?.type === "subquery"
        ? node.from.alias
        : undefined
  return {
    node,
    table,
    columnSources: buildColumnSources(node.columns, table),
  }
}

function dmlContext(
  node: InsertNode | UpdateNode | DeleteNode,
  returning: ExpressionNode[],
): ResultContext {
  const table = node.table.name
  return {
    node,
    table,
    columnSources: returning.length > 0 ? buildColumnSources(returning, table) : undefined,
  }
}

function buildColumnSources(
  columns: ExpressionNode[],
  defaultTable: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const col of columns) {
    const pair = resolveColumn(col, defaultTable)
    if (pair) out[pair.outputName] = pair.table
  }
  return out
}

function resolveColumn(
  expr: ExpressionNode,
  defaultTable: string | undefined,
): { outputName: string; table: string } | undefined {
  if (expr.type === "column_ref") {
    return columnRefSource(expr, defaultTable)
  }
  if (expr.type === "aliased_expr" && expr.expr.type === "column_ref") {
    const src = columnRefSource(expr.expr, defaultTable)
    return src ? { outputName: expr.alias, table: src.table } : undefined
  }
  // `star` is intentionally unresolved: we'd need the schema to list
  // output columns, and the plugin layer doesn't have it here.
  return undefined
}

function columnRefSource(
  ref: ColumnRefNode,
  defaultTable: string | undefined,
): { outputName: string; table: string } | undefined {
  const table = ref.table ?? defaultTable
  if (!table) return undefined
  return { outputName: ref.alias ?? ref.column, table }
}

/**
 * Re-export — useful so plugins can also refer to the "star" shape
 * without importing the AST node module directly when they sanity-check
 * whether the query produced a predictable shape.
 */
export type { StarNode }
