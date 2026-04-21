import type { DeleteNode, InsertNode } from "../ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { BasePrinter } from "./base.ts"

export class PgPrinter extends BasePrinter {
  constructor() {
    super("pg")
  }

  protected override printInsert(node: InsertNode): string {
    if (node.insertMode && node.insertMode !== "INSERT") {
      // `INSERT OR IGNORE / REPLACE / ...` is SQLite-only. Point callers
      // at PG's native upsert path so they don't silently ship invalid SQL.
      throw new UnsupportedDialectFeatureError(
        "pg",
        `${node.insertMode} (SQLite-only — use .onConflict({ columns, do: ... }) on PG)`,
      )
    }
    return super.printInsert(node)
  }

  /**
   * PostgreSQL has no `DELETE … JOIN` — the multi-table form uses
   * `USING`:
   *   `DELETE FROM t USING other WHERE t.id = other.x AND …`
   * The base printer naively emits `JOIN` clauses (as in SELECT), which
   * PG rejects at parse. MySQL and MSSQL got their rewrites in prior
   * audits; PG was left silently broken. Reject with a pointer at
   * `.using(...)`.
   */
  protected override printDelete(node: DeleteNode): string {
    if (node.joins.length > 0) {
      throw new UnsupportedDialectFeatureError(
        "pg",
        "DELETE … JOIN (PG has no JOIN on DELETE — use `.using(other)` and move the ON predicate into WHERE)",
      )
    }
    return super.printDelete(node)
  }
}
