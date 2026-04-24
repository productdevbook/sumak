import { and, col, eq, param } from "../ast/expression.ts"
import type {
  ASTNode,
  DeleteNode,
  ExpressionNode,
  InsertNode,
  JoinNode,
  MergeNode,
  MergeWhenNotMatched,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { QueryFlags } from "../ast/nodes.ts"
import { CrossTenantJoinError } from "../errors.ts"
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
  private strict: boolean

  constructor(config: {
    tables: string[]
    column?: string
    tenantId: unknown | (() => unknown)
    /**
     * Strict mode (default: false). When true, every JOIN on a
     * tenant-aware table is validated:
     *   - The joined table must either be in the `tables` allow-list
     *     (in which case its ON clause gets a `tenant_id = ?` guard
     *     too) or the query must opt out via `.crossTenant({ reason })`.
     *   - A JOIN to a table outside the allow-list without the opt-out
     *     flag throws {@link CrossTenantJoinError} at compile time.
     *
     * Non-strict mode (the legacy behaviour) keeps the main `from`
     * table filtered but leaves JOINed tables alone — adequate only
     * when every joined table is tenant-partitioned some other way
     * (RLS, column-level predicates, etc.).
     */
    strict?: boolean
  }) {
    this.tables = new Set(config.tables)
    this.column = config.column ?? "tenant_id"
    this.getTenantId =
      typeof config.tenantId === "function"
        ? (config.tenantId as () => unknown)
        : () => config.tenantId
    this.strict = config.strict ?? false
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

  /**
   * Build the `<qualifier?>.tenant_id = ?` predicate. When the query
   * has JOINs the qualifier is required — without it, an unqualified
   * `tenant_id` reference is ambiguous across the FROM table and the
   * joined tables. When there are no JOINs we omit the qualifier so
   * the generated SQL stays readable in the common single-table
   * case.
   */
  private tenantCondition(qualifier?: string): ExpressionNode {
    const ref: ExpressionNode = qualifier
      ? { type: "column_ref", table: qualifier, column: this.column }
      : col(this.column)
    return eq(ref, param(0, this.getTenantId()))
  }

  private addCondition(existing: ExpressionNode | undefined, qualifier?: string): ExpressionNode {
    const condition = this.tenantCondition(qualifier)
    return existing ? and(existing, condition) : condition
  }

  private transformSelect(node: SelectNode): SelectNode {
    // Idempotent: PluginManager walks child SELECTs (CTEs, subqueries)
    // and re-dispatches through every plugin. Without this flag a
    // SelectNode that was already filtered would get `AND tenant_id=?`
    // appended a second time on every recursion level.
    const flags = node.flags ?? 0
    if (flags & QueryFlags.MultiTenantApplied) return node
    if (!node.from || node.from.type !== "table_ref" || !this.isTargetTable(node.from.name)) {
      return node
    }

    const optOut = (flags & QueryFlags.CrossTenantOptOut) !== 0

    // Strict-mode JOIN validation. Every JOIN on a TableRefNode must
    // either hit a tenant-aware table (filter is injected below) or
    // the query must carry the CrossTenantOptOut flag. JOINs to
    // subqueries are left alone — the inner SELECT gets its own
    // tenant filter via transformSelect recursion.
    const fromTable = node.from.name
    const newJoins: JoinNode[] = []
    for (const j of node.joins) {
      if (j.table.type !== "table_ref") {
        newJoins.push(j)
        continue
      }
      const joined = j.table.name
      if (this.isTargetTable(joined)) {
        // Add `joined.tenant_id = ?` to the join's ON.
        const qualified: ExpressionNode = {
          type: "column_ref",
          table: j.table.alias ?? joined,
          column: this.column,
        }
        const guard = eq(qualified, param(0, this.getTenantId()))
        newJoins.push({ ...j, on: j.on ? and(j.on, guard) : guard })
      } else if (this.strict && !optOut) {
        throw new CrossTenantJoinError({ table: fromTable, joinedTable: joined })
      } else {
        newJoins.push(j)
      }
    }

    // When the query has JOINs, disambiguate the main WHERE filter by
    // qualifying with the FROM table (or its alias). Multi-table
    // queries would otherwise hit PG's "column reference is ambiguous"
    // if the joined table also has a `tenant_id` column — which is
    // common when both sides are tenant-aware.
    const mainQualifier = node.joins.length > 0 ? (node.from.alias ?? fromTable) : undefined

    return {
      ...node,
      where: this.addCondition(node.where, mainQualifier),
      joins: newJoins,
      flags: flags | QueryFlags.MultiTenantApplied,
    }
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    const flags = node.flags ?? 0
    if (flags & QueryFlags.MultiTenantApplied) return node
    if (!this.isTargetTable(node.table.name)) return node
    return {
      ...node,
      where: this.addCondition(node.where),
      flags: flags | QueryFlags.MultiTenantApplied,
    }
  }

  private transformDelete(node: DeleteNode): DeleteNode {
    const flags = node.flags ?? 0
    if (flags & QueryFlags.MultiTenantApplied) return node
    if (!this.isTargetTable(node.table.name)) return node
    return {
      ...node,
      where: this.addCondition(node.where),
      flags: flags | QueryFlags.MultiTenantApplied,
    }
  }

  private transformInsert(node: InsertNode): InsertNode {
    const flags = node.flags ?? 0
    if (flags & QueryFlags.MultiTenantApplied) return node
    if (!this.isTargetTable(node.table.name)) return node
    const tenantId = this.getTenantId()
    const columns = [...node.columns, this.column]
    const values = node.values.map((row) => [...row, param(0, tenantId)])
    return { ...node, columns, values, flags: flags | QueryFlags.MultiTenantApplied }
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
    const flags = node.flags ?? 0
    // Idempotent — a second pass (double-registered plugin, cached AST)
    // would otherwise duplicate `tenant_id = ?` on ON and raise a
    // "duplicate column" error from the INSERT branch.
    //
    // Note: the flag implies "this plugin already walked this *node*".
    // The `source` / target / alias on a MergeNode is immutable once it
    // leaves the builder, so skipping is safe — there is no valid path
    // where re-entry would see a different `source` than the first run.
    if (flags & QueryFlags.MultiTenantApplied) return node
    if (!this.isTargetTable(node.target.name)) return node
    const tenantId = this.getTenantId()
    let onExpr = node.on

    // Target isolation: `target.tenant_id = ?`.
    const targetQualified: ExpressionNode = {
      type: "column_ref",
      table: node.target.alias ?? node.target.name,
      column: this.column,
    }
    onExpr = and(onExpr, eq(targetQualified, param(0, tenantId)))

    // Source isolation: if the source is also a tenant-aware table, match
    // only same-tenant rows so a WHEN MATCHED UPDATE cannot copy payload
    // from a cross-tenant source into our tenant's row.
    if (node.source.type === "table_ref" && this.isTargetTable(node.source.name)) {
      const sourceQualified: ExpressionNode = {
        type: "column_ref",
        table: node.sourceAlias,
        column: this.column,
      }
      onExpr = and(onExpr, eq(sourceQualified, param(0, tenantId)))
    } else if (node.source.type === "subquery") {
      // Subquery source — we can't inspect its tenant handling statically.
      // The subquery itself should have been transformed by this same
      // plugin's `transformSelect`, which adds the tenant_id filter to
      // its WHERE. That makes subquery sources safe *as long as the
      // inner select is over a tenant-aware table*. We don't guard
      // against other shapes (CTE, raw), so the author remains
      // responsible for those.
    }

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
      on: onExpr,
      whens,
      flags: flags | QueryFlags.MultiTenantApplied,
    }
  }
}
