/**
 * Minimal argv parser — no third-party arg libraries. Supports:
 *   --flag             → { flag: true }
 *   --flag value       → { flag: "value" }
 *   --flag=value       → { flag: "value" }
 *   --no-flag          → { flag: false }
 *   positional args    → collected under `_`
 *
 * Subcommand dispatch is caller-driven: the first positional is the
 * subcommand name, the rest are subcommand arguments. Flags may
 * appear before or after the subcommand.
 */
export interface ParsedArgs {
  readonly command?: string
  readonly positional: readonly string[]
  readonly flags: Readonly<Record<string, string | boolean>>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf("=")
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    if (body.startsWith("no-")) {
      flags[body.slice(3)] = false
      continue
    }
    // Peek ahead: if the next arg exists and isn't itself a flag,
    // treat it as the value. Otherwise it's a bare boolean.
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next
      i++
    } else {
      flags[body] = true
    }
  }

  return {
    command: positional[0],
    positional: positional.slice(1),
    flags,
  }
}
