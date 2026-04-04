import { and, col, eq, param } from "../ast/expression.ts"
import type {
  ASTNode,
  DeleteNode,
  ExpressionNode,
  InsertNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * Plugin that auto-injects tenant_id filtering on all queries for configured tables.
 *
 * - SELECT/UPDATE/DELETE: adds `WHERE tenant_id = ?` (ANDed with existing WHERE)
 * - INSERT: adds tenant_id column and value to each row
 *
 * `tenantId` accepts a value OR a function that returns the value per-query.
 * Use a function for per-request tenant resolution (JWT, session, etc.):
 *
 * ```ts
 * new MultiTenantPlugin({
 *   tables: ["users", "posts"],
 *   tenantId: () => getCurrentTenantId(),
 * })
 * ```
 */
export class MultiTenantPlugin implements SumakPlugin {
  readonly name = "multi-tenant"
  private tables: ReadonlySet<string>
  private column: string
  private getTenantId: () => unknown

  constructor(config: { tables: string[]; column?: string; tenantId: unknown | (() => unknown) }) {
    this.tables = new Set(config.tables)
    this.column = config.column ?? "tenant_id"
    this.getTenantId =
      typeof config.tenantId === "function"
        ? (config.tenantId as () => unknown)
        : () => config.tenantId
  }

  transformNode(node: ASTNode): ASTNode {
    switch (node.type) {
      case "select":
        return this.transformSelect(node)
      case "update":
        return this.transformUpdate(node)
      case "delete":
        return this.transformDelete(node)
      case "insert":
        return this.transformInsert(node)
      default:
        return node
    }
  }

  private isTargetTable(tableName: string): boolean {
    return this.tables.has(tableName)
  }

  private tenantCondition(): ExpressionNode {
    return eq(col(this.column), param(0, this.getTenantId()))
  }

  private addCondition(existing: ExpressionNode | undefined): ExpressionNode {
    const condition = this.tenantCondition()
    return existing ? and(existing, condition) : condition
  }

  private transformSelect(node: SelectNode): SelectNode {
    if (!node.from || node.from.type !== "table_ref" || !this.isTargetTable(node.from.name)) {
      return node
    }
    return { ...node, where: this.addCondition(node.where) }
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.isTargetTable(node.table.name)) return node
    return { ...node, where: this.addCondition(node.where) }
  }

  private transformDelete(node: DeleteNode): DeleteNode {
    if (!this.isTargetTable(node.table.name)) return node
    return { ...node, where: this.addCondition(node.where) }
  }

  private transformInsert(node: InsertNode): InsertNode {
    if (!this.isTargetTable(node.table.name)) return node
    const tenantId = this.getTenantId()
    const columns = [...node.columns, this.column]
    const values = node.values.map((row) => [...row, param(0, tenantId)])
    return { ...node, columns, values }
  }
}
