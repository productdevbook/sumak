import type { Driver } from "../driver/types.ts"
import type { SQLDialect } from "../types.ts"
import { generateSchemaCode } from "./generate.ts"
import { introspectMssql } from "./mssql.ts"
import { introspectMysql } from "./mysql.ts"
import { introspectPg } from "./pg.ts"
import { introspectSqlite } from "./sqlite.ts"
import type { IntrospectedSchema } from "./types.ts"

/**
 * Introspect the schema reachable through `driver`, dispatched on
 * `dialect`. Each dialect has a dedicated introspector under
 * `src/introspect/<name>.ts` — this is the umbrella entry point.
 *
 * ```ts
 * const schema = await introspect(pgDriver(pool), "pg", { schema: "public" })
 * const code = generateSchemaCode(schema)  // → ready-to-write .ts source
 * ```
 */
export async function introspect(
  driver: Driver,
  dialect: SQLDialect,
  options: { schema?: string; database?: string } = {},
): Promise<IntrospectedSchema> {
  switch (dialect) {
    case "pg":
      return introspectPg(driver, { schema: options.schema })
    case "mysql":
      return introspectMysql(driver, { database: options.database })
    case "sqlite":
      return introspectSqlite(driver)
    case "mssql":
      return introspectMssql(driver, { schema: options.schema })
  }
}

export { generateSchemaCode, introspectMssql, introspectMysql, introspectPg, introspectSqlite }
export type { GenerateOptions } from "./generate.ts"
export type { IntrospectedColumn, IntrospectedSchema, IntrospectedTable } from "./types.ts"
