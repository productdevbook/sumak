import { describe, expect, it } from "vitest"

import { parseArgs } from "../../src/cli/args.ts"

describe("parseArgs", () => {
  it("splits positional args from the subcommand", () => {
    const r = parseArgs(["migrate", "plan"])
    expect(r.command).toBe("migrate")
    expect(r.positional).toEqual(["plan"])
  })

  it("supports --flag=value", () => {
    const r = parseArgs(["migrate", "--config=custom.ts"])
    expect(r.flags.config).toBe("custom.ts")
  })

  it("supports --flag value (space-separated)", () => {
    const r = parseArgs(["migrate", "--out", "schema.sql"])
    expect(r.flags.out).toBe("schema.sql")
  })

  it("treats a bare --flag as boolean true", () => {
    const r = parseArgs(["migrate", "--help"])
    expect(r.flags.help).toBe(true)
  })

  it("turns --no-flag into { flag: false }", () => {
    const r = parseArgs(["migrate", "--no-transaction"])
    expect(r.flags.transaction).toBe(false)
  })

  it("peeks ahead correctly — a flag followed by another flag is still boolean", () => {
    const r = parseArgs(["migrate", "--help", "--config=x"])
    expect(r.flags.help).toBe(true)
    expect(r.flags.config).toBe("x")
  })

  it("returns command: undefined for empty argv", () => {
    const r = parseArgs([])
    expect(r.command).toBeUndefined()
    expect(r.positional).toEqual([])
    expect(r.flags).toEqual({})
  })
})
