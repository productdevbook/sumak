#!/usr/bin/env node
// Shebang wrapper — forwards to the real CLI, which lives at dist/cli/main.mjs
// after the build. Kept thin so CLI logic stays testable from source.
import { runCli } from "../dist/cli/index.mjs"

const code = await runCli(process.argv.slice(2))
process.exit(code)
