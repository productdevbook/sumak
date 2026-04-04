import type { ASTNode, DeleteNode, ExpressionNode, SelectNode, UpdateNode } from "../ast/nodes.ts";
import { and, col, isNull } from "../ast/expression.ts";
import type { SumakPlugin } from "./types.ts";

/**
 * Plugin that automatically adds `WHERE deleted_at IS NULL` to
 * SELECT, UPDATE, and DELETE queries for configured tables.
 *
 * ```ts
 * const plugin = new SoftDeletePlugin({ tables: ["users", "posts"] });
 * // SELECT * FROM "users" → SELECT * FROM "users" WHERE "deleted_at" IS NULL
 * ```
 */
export class SoftDeletePlugin implements SumakPlugin {
  readonly name = "soft-delete";
  private tables: ReadonlySet<string>;
  private column: string;

  constructor(config: { tables: string[]; column?: string }) {
    this.tables = new Set(config.tables);
    this.column = config.column ?? "deleted_at";
  }

  transformNode(node: ASTNode): ASTNode {
    switch (node.type) {
      case "select":
        return this.transformSelect(node);
      case "update":
        return this.transformUpdate(node);
      case "delete":
        return this.transformDelete(node);
      default:
        return node;
    }
  }

  private isTargetTable(tableName: string): boolean {
    return this.tables.has(tableName);
  }

  private softDeleteCondition(): ExpressionNode {
    return isNull(col(this.column));
  }

  private addCondition(existing: ExpressionNode | undefined): ExpressionNode {
    const condition = this.softDeleteCondition();
    return existing ? and(existing, condition) : condition;
  }

  private transformSelect(node: SelectNode): SelectNode {
    if (!node.from || node.from.type !== "table_ref" || !this.isTargetTable(node.from.name)) {
      return node;
    }
    return { ...node, where: this.addCondition(node.where) };
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.isTargetTable(node.table.name)) return node;
    return { ...node, where: this.addCondition(node.where) };
  }

  private transformDelete(node: DeleteNode): DeleteNode {
    if (!this.isTargetTable(node.table.name)) return node;
    return { ...node, where: this.addCondition(node.where) };
  }
}
