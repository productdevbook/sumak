import type { InsertNode } from "../ast/nodes.ts"
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
}
