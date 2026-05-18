import { MssqlPrinter } from "../printer/mssql.ts"
import type { Dialect } from "./types.ts"

/**
 * Microsoft SQL Server dialect factory.
 *
 * Identifier quoting uses square brackets (`[id]`), parameter
 * placeholders are `@p0` / `@p1` / … (named), and the printer
 * handles MSSQL-only conventions: `TOP n` instead of `LIMIT`,
 * `OFFSET … FETCH NEXT … ROWS ONLY` for paging, no `LATERAL`
 * (use `OUTER APPLY` instead — emitted automatically when the
 * builder uses a subquery that would otherwise need LATERAL), no
 * `ON CONFLICT` (use `MERGE`), `BIT` for booleans, `DATETIME2`
 * for timestamps.
 *
 * ```ts
 * import { sumak, mssqlDialect } from "sumak"
 *
 * const db = sumak({
 *   dialect: mssqlDialect(),
 *   tables: { ... },
 * })
 * ```
 *
 * Pair with the `mssql` (`node-mssql`) package via the
 * `sumak/drivers/mssql` adapter for end-to-end execution.
 */
export function mssqlDialect(): Dialect {
  return {
    name: "mssql",
    createPrinter() {
      return new MssqlPrinter()
    },
  }
}
