import type {
  ASTNode,
  DeleteNode,
  ExpressionNode,
  InsertNode,
  MergeNode,
  SelectNode,
  UpdateNode,
} from "./nodes.ts"
import { ASTWalker } from "./walker.ts"

/**
 * Legacy public transformer API — kept as a thin shim over {@link ASTWalker}.
 *
 * Subclasses override `transformExpression` (and optionally the DML
 * transforms) to rewrite nodes. Every override delegates to `super`
 * for the default identity-preserving traversal, which is provided by
 * {@link ASTWalker}. New code should extend `ASTWalker` directly — the
 * walker's exhaustive switch surface makes new AST variants impossible
 * to forget, and its traversal covers CTEs / subqueries / MERGE WHEN
 * branches that the legacy `ASTTransformer` skipped.
 *
 * Kept public because `ns/ast.ts` re-exports it as `ast.Transformer`.
 */
export class ASTTransformer extends ASTWalker {
  transform(node: ASTNode): ASTNode {
    return this.visitNode(node)
  }

  transformSelect(node: SelectNode): SelectNode {
    return this.visitSelect(node)
  }

  transformInsert(node: InsertNode): InsertNode {
    return this.visitInsert(node)
  }

  transformUpdate(node: UpdateNode): UpdateNode {
    return this.visitUpdate(node)
  }

  transformDelete(node: DeleteNode): DeleteNode {
    return this.visitDelete(node)
  }

  transformMerge(node: MergeNode): MergeNode {
    return this.visitMerge(node)
  }

  /**
   * Default: delegate to the walker so child expressions are walked
   * identity-preservingly. Subclasses override this method to rewrite
   * specific expression shapes; they should call `super.transformExpression`
   * for nodes they don't match so inner children still get traversed.
   */
  transformExpression(node: ExpressionNode): ExpressionNode {
    return super.visitExpression(node)
  }

  // Route the walker's internal recursion through `transformExpression`
  // so subclass overrides see every expression in the tree.
  override visitExpression(expr: ExpressionNode): ExpressionNode {
    return this.transformExpression(expr)
  }
}
