import { and, col, eq, param } from "../ast/expression.ts"
import type {
  ASTNode,
  DeleteNode,
  ExpressionNode,
  InsertNode,
  MergeNode,
  MergeWhenNotMatched,
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
      case "merge":
        return this.transformMerge(node)
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

  /**
   * MERGE tenant isolation — **SECURITY CRITICAL**.
   *
   * Without this transform, a `MERGE INTO users USING staging ON
   * target.id = source.id` with a multi-tenant schema can match rows
   * across tenants: a source row from tenant A could update a target
   * row belonging to tenant B, or a WHEN NOT MATCHED INSERT can write
   * a row with no tenant_id set (or the source's tenant_id).
   *
   * We:
   *  1. Qualify the ON predicate with `target.tenant_id = ?` so only
   *     rows in the current tenant can match.
   *  2. Inject `tenant_id` into every WHEN NOT MATCHED INSERT column
   *     list and values tuple, so new rows always carry the current
   *     tenant's id regardless of what the source table looks like.
   */
  private transformMerge(node: MergeNode): MergeNode {
    if (!this.isTargetTable(node.target.name)) return node
    const tenantId = this.getTenantId()
    const qualified: ExpressionNode = {
      type: "column_ref",
      table: node.target.alias ?? node.target.name,
      column: this.column,
    }
    const tenantMatch: ExpressionNode = eq(qualified, param(0, tenantId))
    const whens = node.whens.map((w) => {
      if (w.type !== "not_matched") return w
      // INSERT branch — add tenant column + value if not already present.
      if (w.columns.includes(this.column)) return w
      const patched: MergeWhenNotMatched = {
        ...w,
        columns: [...w.columns, this.column],
        values: [...w.values, param(0, tenantId)],
      }
      return patched
    })
    return {
      ...node,
      on: and(node.on, tenantMatch),
      whens,
    }
  }
}
