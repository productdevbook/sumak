import { mssqlDialect } from "../dialect/mssql.ts"
import { mysqlDialect } from "../dialect/mysql.ts"
import { pgDialect } from "../dialect/pg.ts"
import { sqliteDialect } from "../dialect/sqlite.ts"
import type { Dialect } from "../dialect/types.ts"
import { CliError } from "./errors.ts"

/**
 * Turn the string name from the user's config (`"pg"`, `"mysql"`,
 * `"sqlite"`, `"mssql"`) into the actual dialect instance. Done here
 * rather than inline in each subcommand so both `migrate` and
 * `generate` share the mapping.
 */
export function loadDialect(name: string): Dialect {
  switch (name) {
    case "pg":
      return pgDialect()
    case "mysql":
      return mysqlDialect()
    case "sqlite":
      return sqliteDialect()
    case "mssql":
      return mssqlDialect()
    default:
      throw new CliError(`Unknown dialect: ${name}. Expected pg / mysql / sqlite / mssql.`)
  }
}
