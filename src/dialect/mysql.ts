import { MysqlPrinter } from "../printer/mysql.ts"
import type { Dialect } from "./types.ts"

/**
 * MySQL / MariaDB dialect factory.
 *
 * Identifier quoting uses backticks (`` `id` ``), parameter placeholders
 * are `?` (positional), and the printer respects MySQL's quirks: no
 * `RETURNING` (MariaDB has it, MySQL doesn't; sumak refuses the feature
 * to keep the cross-target story honest), no `DISTINCT ON`, no
 * `LATERAL`, `INSERT … ON DUPLICATE KEY UPDATE` instead of PG's
 * `ON CONFLICT`, `JSON_EXTRACT` instead of `->>`.
 *
 * ```ts
 * import { sumak, mysqlDialect } from "sumak"
 *
 * const db = sumak({
 *   dialect: mysqlDialect(),
 *   tables: { ... },
 * })
 * ```
 *
 * Pair with `mysql2` via the `sumak/drivers/mysql2` adapter for
 * end-to-end execution.
 */
export function mysqlDialect(): Dialect {
  return {
    name: "mysql",
    createPrinter() {
      return new MysqlPrinter()
    },
  }
}
