import { resolve } from "node:path"

import { parseArgs } from "./args.ts"
import { generateCommand } from "./commands/generate.ts"
import { introspectCommand } from "./commands/introspect.ts"
import { migrateCommand } from "./commands/migrate.ts"
import { CliError } from "./errors.ts"
import { loadConfig } from "./load-config.ts"

/**
 * Entry point for the `sumak` CLI. Exported separately from the shebang
 * wrapper (`bin/sumak.mjs`) so it's testable in-process.
 *
 * Synopsis:
 *   sumak <command> [options]
 *
 * Commands:
 *   migrate [up|plan]     apply / preview pending DDL
 *   introspect            read the DB, emit a sumak schema file
 *   generate              emit the migration SQL without running it
 *
 * Global options:
 *   --config <path>       path to sumak config (default: ./sumak.config.ts)
 *   --help                print this help
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)

  if (args.flags.help === true || args.command === "help" || args.command === undefined) {
    printHelp()
    return args.command ? 0 : 1
  }

  const configPath = resolve(
    process.cwd(),
    typeof args.flags.config === "string" ? args.flags.config : "sumak.config.ts",
  )

  try {
    const config = await loadConfig(configPath)
    const forwardedArgs = { flags: args.flags, positional: args.positional }
    switch (args.command) {
      case "migrate":
        await migrateCommand(config, forwardedArgs)
        return 0
      case "introspect":
        await introspectCommand(config, forwardedArgs)
        return 0
      case "generate":
        await generateCommand(config, forwardedArgs)
        return 0
      default:
        throw new CliError(`Unknown command: ${args.command}. Run \`sumak help\` for usage.`)
    }
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`)
      return 1
    }
    throw err
  }
}

function printHelp(): void {
  process.stdout.write(
    `sumak — type-safe SQL query builder & migration tool

Usage:
  sumak <command> [options]

Commands:
  migrate [up|plan]     apply or preview pending DDL
  introspect            read the live database, emit a sumak schema file
  generate              emit the migration SQL without running it

Options:
  --config <path>       path to sumak.config.ts (default ./sumak.config.ts)
  --out <path>          output file override (introspect / generate)
  --print               force stdout even when outFile is set (introspect)
  --allow-destructive   permit DROP COLUMN / DROP TABLE / narrowing type changes
  --no-transaction      disable the BEGIN/COMMIT wrapper around migrate up
  --no-lock             skip the advisory lock during migrate up
  --help                print this help

Examples:
  sumak migrate plan
  sumak migrate up --allow-destructive
  sumak introspect --out src/schema.generated.ts
  sumak generate --out ./migrations/001_init.sql
`,
  )
}
