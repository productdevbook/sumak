import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runCli } from "../../src/cli/main.ts"

// End-to-end for the CLI entry point — we drop a minimal sumak.config
// into a temp dir, run runCli() against it, and capture stdout/stderr.
// The config pipes through a mock driver so `migrate plan` can run
// without talking to a real database.

let tmp: string
let originalStdoutWrite: typeof process.stdout.write
let originalStderrWrite: typeof process.stderr.write
let stdoutBuf: string
let stderrBuf: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sumak-cli-"))
  stdoutBuf = ""
  stderrBuf = ""
  originalStdoutWrite = process.stdout.write.bind(process.stdout)
  originalStderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
})

afterEach(async () => {
  process.stdout.write = originalStdoutWrite
  process.stderr.write = originalStderrWrite
  await rm(tmp, { recursive: true, force: true })
})

async function writeConfig(contents: string): Promise<string> {
  const path = join(tmp, "sumak.config.mjs")
  await writeFile(path, contents, "utf8")
  return path
}

describe("runCli — help", () => {
  it("prints help when no command is given", async () => {
    const code = await runCli([])
    expect(code).toBe(1) // no command → exit 1
    expect(stdoutBuf).toMatch(/sumak —/)
    expect(stdoutBuf).toMatch(/migrate/)
  })

  it("prints help and exits 0 for --help", async () => {
    const code = await runCli(["help"])
    expect(code).toBe(0)
    expect(stdoutBuf).toMatch(/migrate/)
  })
})

describe("runCli — migrate plan", () => {
  it("emits DDL against an empty live schema", async () => {
    const path = await writeConfig(`
      import { defineConfig } from "${process.cwd()}/src/cli/index.ts"
      import { pgDialect } from "${process.cwd()}/src/dialect/pg.ts"
      import { serial, text } from "${process.cwd()}/src/schema/column.ts"

      const mockDriver = {
        async query() { return [] },
        async execute() { return { affected: 0 } },
      }

      export default defineConfig({
        dialect: "pg",
        driver: () => mockDriver,
        schema: () => ({
          tables: {
            users: { id: serial().primaryKey(), name: text().notNull() },
          },
        }),
      })
    `)

    const code = await runCli(["migrate", "plan", "--config", path])
    expect(code).toBe(0)
    expect(stdoutBuf).toMatch(/CREATE TABLE/i)
    expect(stdoutBuf).toMatch(/users/)
  })

  it("reports no-op when before == after (only possible here because before is {})", async () => {
    const path = await writeConfig(`
      import { defineConfig } from "${process.cwd()}/src/cli/index.ts"
      export default defineConfig({
        dialect: "pg",
        driver: () => ({ async query(){return []}, async execute(){return {affected:0}} }),
        schema: () => ({ tables: {} }),
      })
    `)

    const code = await runCli(["migrate", "plan", "--config", path])
    expect(code).toBe(0)
    expect(stdoutBuf).toMatch(/no changes/)
  })
})

describe("runCli — unknown command", () => {
  it("exits 1 with a helpful error", async () => {
    const path = await writeConfig(`
      import { defineConfig } from "${process.cwd()}/src/cli/index.ts"
      export default defineConfig({
        dialect: "pg",
        driver: () => ({ async query(){return []}, async execute(){return {affected:0}} }),
        schema: () => ({ tables: {} }),
      })
    `)

    const code = await runCli(["frobnicate", "--config", path])
    expect(code).toBe(1)
    expect(stderrBuf).toMatch(/Unknown command: frobnicate/)
  })
})
