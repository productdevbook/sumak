import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { generateSchemaCode } from "../../introspect/generate.ts"
import { introspectMssql } from "../../introspect/mssql.ts"
import { introspectMysql } from "../../introspect/mysql.ts"
import { introspectPg } from "../../introspect/pg.ts"
import { introspectSqlite } from "../../introspect/sqlite.ts"
import type { SumakConfig } from "../config.ts"
import { CliError } from "../errors.ts"

/**
 * `sumak introspect` — read the live database through the configured
 * driver, generate the TypeScript schema source, and either print it
 * to stdout (default) or write it to the configured `outFile`.
 *
 * Flags:
 *   --out <path>   override outFile
 *   --print        force stdout even when outFile is set
 */
export async function introspectCommand(
  config: SumakConfig,
  args: {
    readonly flags: Readonly<Record<string, string | boolean>>
    readonly positional: readonly string[]
  },
): Promise<void> {
  const driver = await config.driver()
  // Dispatch on dialect; each reader returns the normalised
  // IntrospectedSchema shape which generateSchemaCode turns into
  // ready-to-write sumak source.
  const schema = await (async () => {
    switch (config.dialect) {
      case "pg":
        return introspectPg(driver, { schema: config.namespace })
      case "mysql":
        return introspectMysql(driver, { database: config.namespace })
      case "sqlite":
        return introspectSqlite(driver)
      case "mssql":
        return introspectMssql(driver, { schema: config.namespace })
      default:
        throw new CliError(`Unknown dialect: ${String(config.dialect)}`)
    }
  })()

  const code = generateSchemaCode(schema)

  const outFlag = args.flags.out
  const printFlag = args.flags.print === true
  const outFile = typeof outFlag === "string" ? outFlag : config.outFile
  if (printFlag || !outFile) {
    process.stdout.write(code)
    return
  }
  const abs = resolve(process.cwd(), outFile)
  await writeFile(abs, code, "utf8")
  process.stderr.write(`✓ wrote ${schema.tables.length} tables → ${abs}\n`)
}
