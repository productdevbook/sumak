import {
  between,
  binOp,
  col,
  colAs,
  eq,
  fn,
  gt,
  gte,
  inList,
  isNull,
  like,
  lit,
  lt,
  lte,
  neq,
  param,
  raw,
  star,
  subquery,
  unaryOp,
} from "../ast/expression.ts"
import {
  createDeleteNode,
  createInsertNode,
  createMergeNode,
  createSelectNode,
  createUpdateNode,
  tableRef,
} from "../ast/nodes.ts"
import { ASTTransformer } from "../ast/transformer.ts"
import { visitNode } from "../ast/visitor.ts"

/**
 * Low-level AST factory namespace — advanced use.
 *
 * Most users never touch this. It's the escape hatch for plugin authors
 * and tooling that needs to construct or rewrite the AST directly.
 *
 * ```ts
 * import { ast } from "sumak"
 *
 * const node = ast.select()
 * const where = ast.binOp("=", ast.col("id"), ast.lit(1))
 * const table = ast.table("users")
 *
 * // Traversal
 * ast.visit(node, visitor)
 * ```
 */
export const ast = {
  // Node factories
  select: createSelectNode,
  insert: createInsertNode,
  update: createUpdateNode,
  delete: createDeleteNode,
  merge: createMergeNode,
  table: tableRef,

  // Expression factories
  col,
  colAs,
  lit,
  star,
  param,
  raw,
  subquery,
  fn,
  binOp,
  unaryOp,
  eq,
  neq,
  gt,
  gte,
  lt,
  lte,
  like,
  between,
  inList,
  isNull,

  // Traversal
  visit: visitNode,
  Transformer: ASTTransformer,
} as const
