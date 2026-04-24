import { fn, param } from "../ast/expression.ts"
import type {
  ASTNode,
  ExpressionNode,
  InsertNode,
  MergeNode,
  MergeWhenMatched,
  MergeWhenNotMatched,
  UpdateNode,
} from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

interface AuditTimestampConfig {
  tables: string[]
  createdAt?: string
  updatedAt?: string
  /**
   * Resolver for the current user's id — called once per DML the
   * plugin fires on. The return value goes into the `createdBy` /
   * `updatedBy` columns. `undefined` means "no current user" and
   * those columns get left out (rather than inserted as NULL, which
   * would collide with a NOT NULL constraint on day-one schemas).
   *
   * Typically a closure over per-request context:
   * `() => request.user?.id`.
   */
  userId?: () => unknown
  /**
   * Column name for the user who inserted the row. Ignored unless
   * `userId` is also set. Default: `"created_by"`.
   */
  createdBy?: string
  /**
   * Column name for the user who last updated the row. Ignored
   * unless `userId` is also set. Default: `"updated_by"`.
   */
  updatedBy?: string
}

/**
 * Plugin that auto-injects created_at/updated_at timestamps.
 *
 * - INSERT: adds created_at and updated_at columns with CURRENT_TIMESTAMP
 * - UPDATE: adds updated_at = CURRENT_TIMESTAMP to the SET clause
 *
 * We emit `CURRENT_TIMESTAMP` rather than `NOW()` because the former is
 * a niladic SQL:92 keyword the printer emits bare (not as a function
 * call). It's portable across pg/mysql/sqlite/mssql; `NOW()` is
 * MySQL/PG-only and fails on MSSQL and SQLite.
 *
 * ```ts
 * const plugin = new AuditTimestampPlugin({ tables: ["users", "posts"] })
 * // INSERT INTO "users" ("name") VALUES ('Ada')
 * // → INSERT INTO "users" ("name", "created_at", "updated_at") VALUES ('Ada', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
 * ```
 */
export class AuditTimestampPlugin implements SumakPlugin {
  readonly name = "audit-timestamp"
  private tables: ReadonlySet<string>
  private createdAt: string
  private updatedAt: string
  private getUserId: (() => unknown) | undefined
  private createdBy: string
  private updatedBy: string

  constructor(config: AuditTimestampConfig) {
    this.tables = new Set(config.tables)
    this.createdAt = config.createdAt ?? "created_at"
    this.updatedAt = config.updatedAt ?? "updated_at"
    this.getUserId = config.userId
    this.createdBy = config.createdBy ?? "created_by"
    this.updatedBy = config.updatedBy ?? "updated_by"
  }

  /**
   * Resolve the current user id and emit it as a parameterised
   * expression. Returns `undefined` when no `userId` resolver was
   * configured or it returned undefined — callers short-circuit in
   * that case so the column is simply left unset.
   */
  private userIdExpr(): ExpressionNode | undefined {
    if (!this.getUserId) return undefined
    const id = this.getUserId()
    if (id === undefined) return undefined
    return param(0, id)
  }

  transformNode(node: ASTNode): ASTNode {
    switch (node.type) {
      case "insert":
        return this.transformInsert(node)
      case "update":
        return this.transformUpdate(node)
      case "merge":
        return this.transformMerge(node)
      default:
        return node
    }
  }

  private isTargetTable(tableName: string): boolean {
    return this.tables.has(tableName)
  }

  private transformInsert(node: InsertNode): InsertNode {
    if (!this.isTargetTable(node.table.name)) return node

    const now = fn("CURRENT_TIMESTAMP", [])
    const userId = this.userIdExpr()

    const extraCols: string[] = [this.createdAt, this.updatedAt]
    const extraVals: ExpressionNode[] = [now, now]
    if (userId) {
      extraCols.push(this.createdBy, this.updatedBy)
      extraVals.push(userId, userId)
    }

    const columns = [...node.columns, ...extraCols]
    const values = node.values.map((row) => [...row, ...extraVals])

    return { ...node, columns, values }
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.isTargetTable(node.table.name)) return node

    const now = fn("CURRENT_TIMESTAMP", [])
    const userId = this.userIdExpr()
    const set = [...node.set, { column: this.updatedAt, value: now }]
    if (userId) set.push({ column: this.updatedBy, value: userId })

    return { ...node, set }
  }

  /**
   * MERGE audit-stamping.
   *
   * - WHEN MATCHED UPDATE → append `updated_at = CURRENT_TIMESTAMP` to the set list.
   * - WHEN NOT MATCHED INSERT → append both `created_at`/`updated_at`
   *   columns and values to the insert tuple.
   * - WHEN MATCHED DELETE → unchanged (no rows written).
   */
  private transformMerge(node: MergeNode): MergeNode {
    if (!this.isTargetTable(node.target.name)) return node
    const now = fn("CURRENT_TIMESTAMP", [])
    const userId = this.userIdExpr()
    const whens = node.whens.map((w) => {
      if (w.type === "matched" && w.action === "update") {
        const existing = w.set ?? []
        const hasUpdated = existing.some((s) => s.column === this.updatedAt)
        const hasUpdatedBy = existing.some((s) => s.column === this.updatedBy)
        const additions: typeof existing = []
        if (!hasUpdated) additions.push({ column: this.updatedAt, value: now })
        if (userId && !hasUpdatedBy) {
          additions.push({ column: this.updatedBy, value: userId })
        }
        if (additions.length === 0) return w
        const patched: MergeWhenMatched = { ...w, set: [...existing, ...additions] }
        return patched
      }
      if (w.type === "not_matched") {
        const missingCreated = !w.columns.includes(this.createdAt)
        const missingUpdated = !w.columns.includes(this.updatedAt)
        const missingCreatedBy = userId !== undefined && !w.columns.includes(this.createdBy)
        const missingUpdatedBy = userId !== undefined && !w.columns.includes(this.updatedBy)
        if (!missingCreated && !missingUpdated && !missingCreatedBy && !missingUpdatedBy) return w
        const extraCols: string[] = []
        const extraVals: typeof w.values = []
        if (missingCreated) {
          extraCols.push(this.createdAt)
          extraVals.push(now)
        }
        if (missingUpdated) {
          extraCols.push(this.updatedAt)
          extraVals.push(now)
        }
        if (missingCreatedBy && userId) {
          extraCols.push(this.createdBy)
          extraVals.push(userId)
        }
        if (missingUpdatedBy && userId) {
          extraCols.push(this.updatedBy)
          extraVals.push(userId)
        }
        const patched: MergeWhenNotMatched = {
          ...w,
          columns: [...w.columns, ...extraCols],
          values: [...w.values, ...extraVals],
        }
        return patched
      }
      return w
    })
    return { ...node, whens }
  }
}
