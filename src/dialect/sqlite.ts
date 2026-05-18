import { SqlitePrinter } from "../printer/sqlite.ts"
import type { Dialect } from "./types.ts"

/**
 * SQLite dialect factory.
 *
 * Identifier quoting uses double quotes (`"id"`), parameter placeholders
 * are `?` (positional), and the printer recognises SQLite-specific
 * behaviour: no native ARRAY types, no `LATERAL`, no `MERGE`, no
 * multi-table `DELETE` (per-row), `INSERT … ON CONFLICT DO …` is
 * supported but without `DO UPDATE SET ... WHERE` until SQLite ≥
 * 3.40. The `RETURNING` clause works from SQLite 3.35.
 *
 * ```ts
 * import { sumak, sqliteDialect } from "sumak"
 *
 * const db = sumak({
 *   dialect: sqliteDialect(),
 *   tables: { ... },
 * })
 * ```
 *
 * Pair with `better-sqlite3` via the `sumak/drivers/better-sqlite3`
 * adapter for end-to-end execution.
 */
export function sqliteDialect(): Dialect {
  return {
    name: "sqlite",
    createPrinter() {
      return new SqlitePrinter()
    },
  }
}
