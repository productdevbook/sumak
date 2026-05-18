import { PgPrinter } from "../printer/pg.ts"
import type { Dialect } from "./types.ts"

/**
 * PostgreSQL dialect factory.
 *
 * Identifier quoting uses double quotes (`"id"`), parameter placeholders
 * are `$1` / `$2` / …, and the printer recognises PG-only features
 * (LATERAL joins, `RETURNING`, `ON CONFLICT`, `INSERT … ON CONFLICT DO
 * UPDATE`, `WITH RECURSIVE`, array operators, JSON path access, full-text
 * search, window-frame `RANGE` / `GROUPS`, `IS DISTINCT FROM`, MERGE).
 *
 * ```ts
 * import { sumak, pgDialect } from "sumak"
 *
 * const db = sumak({
 *   dialect: pgDialect(),
 *   tables: { ... },
 * })
 * ```
 *
 * Pair with a `pg` (`node-postgres`) or `postgres` (`postgres.js`) driver
 * via the `sumak/drivers/pg` adapter for end-to-end execution.
 */
export function pgDialect(): Dialect {
  return {
    name: "pg",
    createPrinter() {
      return new PgPrinter()
    },
  }
}
