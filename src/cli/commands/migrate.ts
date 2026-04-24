import { applyMigration, planMigration } from "../../migrate/runner.ts"
import { sumak } from "../../sumak.ts"
import type { SumakConfig } from "../config.ts"
import { loadDialect } from "../dialect.ts"
import { CliError } from "../errors.ts"
import { introspectForMigrate } from "./introspect-runtime.ts"

/**
 * `sumak migrate` — diff the live database against the TypeScript
 * schema and apply the difference. Mirrors the in-process
 * `applyMigration()` API exactly; the CLI is a thin wrapper.
 *
 * Subcommands:
 *   sumak migrate          (apply — same as `migrate up`)
 *   sumak migrate up       (apply — explicit)
 *   sumak migrate plan     (print SQL without running it)
 *
 * Flags:
 *   --allow-destructive   permit DROP COLUMN / DROP TABLE / type narrowing
 *   --no-transaction      disable the BEGIN/COMMIT wrapper
 *   --no-lock             skip the advisory lock
 *   --yes                 auto-confirm destructive changes in `up`
 */
export async function migrateCommand(
  config: SumakConfig,
  args: {
    readonly flags: Readonly<Record<string, string | boolean>>
    readonly positional: readonly string[]
  },
): Promise<void> {
  const sub = args.positional[0] ?? "up"
  if (sub !== "up" && sub !== "plan") {
    throw new CliError(`Unknown migrate subcommand: ${sub}. Expected \`up\` or \`plan\`.`)
  }

  const driver = await config.driver()
  const schemaOrDb = await config.schema()
  // Accept either `{ tables }` shape (the common case) or a full
  // Sumak instance. Either way we only need the tables record to
  // drive the diff; the apply path builds its own sumak with the
  // driver bound.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = (
    "tables" in schemaOrDb && typeof schemaOrDb.tables === "object"
      ? (schemaOrDb as { tables: unknown }).tables
      : (schemaOrDb as unknown as { _config: { tables: unknown } })._config.tables
  ) as any

  const dialect = loadDialect(config.dialect)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = sumak({ dialect, driver, tables }) as any

  // Read the live schema so the diff has a `before` value. The
  // introspector returns the IntrospectedSchema shape, which we
  // translate into a tables record the diff engine understands.
  const before = await introspectForMigrate(driver, config.dialect, config.namespace)

  const allowDestructive = args.flags["allow-destructive"] === true
  const useTransaction = args.flags.transaction !== false
  const useLock = args.flags.lock !== false

  if (sub === "plan") {
    const plan = planMigration(db, before, tables, { allowDestructive })
    if (plan.steps.length === 0) {
      process.stdout.write("-- no changes\n")
      return
    }
    for (let i = 0; i < plan.steps.length; i++) {
      const node = plan.nodes[i]!
      const step = plan.steps[i]!
      process.stdout.write(`-- ${node.type}\n`)
      process.stdout.write(`${step.sql};\n\n`)
    }
    if (plan.hasDestructiveSteps) {
      process.stderr.write(
        `⚠ plan includes destructive steps; pass --allow-destructive to apply.\n`,
      )
    }
    return
  }

  const result = await applyMigration(db, before, tables, {
    allowDestructive,
    transaction: useTransaction,
    lock: useLock,
  })
  if (result.applied === 0) {
    process.stderr.write("✓ schema already up to date\n")
    return
  }
  process.stderr.write(`✓ applied ${result.applied} step(s)\n`)
}
