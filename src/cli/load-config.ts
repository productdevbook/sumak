import { pathToFileURL } from "node:url"

import type { SumakConfig } from "./config.ts"
import { CliError } from "./errors.ts"

/**
 * Load a `sumak.config.ts` (or .js / .mjs) from the filesystem.
 * Uses dynamic `import()` so the config file can be ESM — which it
 * needs to be to `import` from `sumak/cli`.
 *
 * For `.ts` configs on Node < 24, users should pre-build with tsc /
 * tsx / a bundler. We don't ship a TS loader because that would mean
 * taking on `tsx` / `esbuild` / similar as runtime deps, breaking
 * the zero-dep promise.
 */
export async function loadConfig(path: string): Promise<SumakConfig> {
  const url = pathToFileURL(path).href
  let mod: { default?: unknown } & Record<string, unknown>
  try {
    mod = (await import(url)) as { default?: unknown } & Record<string, unknown>
  } catch (cause) {
    throw new CliError(
      `Failed to load config at ${path}: ${(cause as Error).message}.\n` +
        `On Node < 24, compile .ts configs to .mjs first (or use tsx).`,
      { cause },
    )
  }

  // Prefer the default export; fall back to a named `config` export
  // for commonjs interop.
  const raw = mod.default ?? mod.config ?? mod
  if (!raw || typeof raw !== "object") {
    throw new CliError(`Config at ${path} must export a SumakConfig object as default.`)
  }
  const cfg = raw as SumakConfig
  if (typeof cfg.dialect !== "string") {
    throw new CliError(`Config at ${path} is missing a string \`dialect\`.`)
  }
  if (typeof cfg.driver !== "function") {
    throw new CliError(`Config at ${path} is missing a \`driver()\` factory.`)
  }
  if (typeof cfg.schema !== "function") {
    throw new CliError(`Config at ${path} is missing a \`schema()\` factory.`)
  }
  return cfg
}
