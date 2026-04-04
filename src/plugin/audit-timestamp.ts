import { fn } from "../ast/expression.ts"
import type { ASTNode, InsertNode, UpdateNode } from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

interface AuditTimestampConfig {
  tables: string[]
  createdAt?: string
  updatedAt?: string
}

/**
 * Plugin that auto-injects created_at/updated_at timestamps.
 *
 * - INSERT: adds created_at and updated_at columns with NOW()
 * - UPDATE: adds updated_at = NOW() to the SET clause
 *
 * ```ts
 * const plugin = new AuditTimestampPlugin({ tables: ["users", "posts"] })
 * // INSERT INTO "users" ("name") VALUES ('Ada')
 * // → INSERT INTO "users" ("name", "created_at", "updated_at") VALUES ('Ada', NOW(), NOW())
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
      default:
        return node
    }
  }

  private isTargetTable(tableName: string): boolean {
    return this.tables.has(tableName)
  }

  private transformInsert(node: InsertNode): InsertNode {
    if (!this.isTargetTable(node.table.name)) return node

    const now = fn("NOW", [])
    const columns = [...node.columns, this.createdAt, this.updatedAt]
    const values = node.values.map((row) => [...row, now, now])

    return { ...node, columns, values }
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    if (!this.isTargetTable(node.table.name)) return node

    const now = fn("NOW", [])
    const set = [...node.set, { column: this.updatedAt, value: now }]

    return { ...node, set }
  }
}
