import { fn } from "../ast/expression.ts"
import type {
  ASTNode,
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

  constructor(config: AuditTimestampConfig) {
    this.tables = new Set(config.tables)
    this.createdAt = config.createdAt ?? "created_at"
    this.updatedAt = config.updatedAt ?? "updated_at"
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
    const columns = [...node.columns, this.createdAt, this.updatedAt]
    const values = node.values.map((row) => [...row, now, now])

    return { ...node, columns, values }
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.isTargetTable(node.table.name)) return node

    const now = fn("CURRENT_TIMESTAMP", [])
    const set = [...node.set, { column: this.updatedAt, value: now }]

    return { ...node, set }
  }

  /**
   * MERGE audit-stamping.
   *
   * - WHEN MATCHED UPDATE → append `updated_at = NOW()` to the set list.
   * - WHEN NOT MATCHED INSERT → append both `created_at`/`updated_at`
   *   columns and values to the insert tuple.
   * - WHEN MATCHED DELETE → unchanged (no rows written).
   */
  private transformMerge(node: MergeNode): MergeNode {
    if (!this.isTargetTable(node.target.name)) return node
    const now = fn("CURRENT_TIMESTAMP", [])
    const whens = node.whens.map((w) => {
      if (w.type === "matched" && w.action === "update") {
        // Don't double-stamp if the caller already set updated_at.
        if (w.set && w.set.some((s) => s.column === this.updatedAt)) return w
        const patched: MergeWhenMatched = {
          ...w,
          set: [...(w.set ?? []), { column: this.updatedAt, value: now }],
        }
        return patched
      }
      if (w.type === "not_matched") {
        const missingCreated = !w.columns.includes(this.createdAt)
        const missingUpdated = !w.columns.includes(this.updatedAt)
        if (!missingCreated && !missingUpdated) return w
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
