import type { Driver } from "../driver/types.ts"
import type { Sumak } from "../sumak.ts"

/**
 * User-facing config file shape. A project places a `sumak.config.ts`
 * at the repository root (or passes `--config <path>`) exporting
 * `defineConfig({...})`. The CLI loads it with dynamic `import()` and
 * uses it to wire up migrate / introspect / generate.
 *
 * ```ts
 * // sumak.config.ts
 * import { defineConfig } from "sumak/cli"
 * import { pgDialect } from "sumak/pg"
 * import { pgDriver } from "sumak/drivers/pg"
 * import { Pool } from "pg"
 *
 * import { tables } from "./src/schema.ts"
 *
 * export default defineConfig({
 *   dialect: "pg",
 *   driver: () => pgDriver(new Pool({ connectionString: process.env.DATABASE_URL })),
 *   schema: () => ({ tables }),
 *   // optional:
 *   outFile: "./src/schema.generated.ts",
 * })
 * ```
 */
export interface SumakConfig {
  readonly dialect: "pg" | "mysql" | "sqlite" | "mssql"
  /**
   * Factory that produces a sumak `Driver`. Called once at CLI
   * invocation. Kept as a factory (not a pre-built driver) so config
   * files stay side-effect free when imported for schema lookup.
   */
  readonly driver: () => Driver | Promise<Driver>
  /**
   * Factory that returns the current schema. The returned shape is a
   * sumak `tables` record (or a full `Sumak` instance if you want the
   * CLI to reuse it verbatim). Declared as a factory so importing the
   * config doesn't pull in heavy schema modules when not needed.
   */
  readonly schema: () =>
    | { readonly tables: Record<string, unknown> }
    | Sumak<Record<string, Record<string, unknown>>>
    | Promise<
        | { readonly tables: Record<string, unknown> }
        | Sumak<Record<string, Record<string, unknown>>>
      >
  /**
   * Output path for `sumak generate` / `sumak introspect`. Defaults to
   * `./sumak-generated.ts` when omitted.
   */
  readonly outFile?: string
  /**
   * Database / schema namespace override. For PG + MSSQL this is the
   * schema name (defaults to `public` / `dbo`); for MySQL the database
   * name (defaults to whatever `DATABASE()` reports).
   */
  readonly namespace?: string
}

/**
 * Identity helper — the only reason it exists is so user code gets
 * editor autocompletion without having to remember the type name.
 */
export function defineConfig(config: SumakConfig): SumakConfig {
  return config
}
