import { describe, expect, it } from "vitest"

import { loadDialect } from "../../src/cli/dialect.ts"
import { CliError } from "../../src/cli/errors.ts"

describe("loadDialect", () => {
  it("returns the concrete dialect instance for each known name", () => {
    expect(loadDialect("pg").name).toBe("pg")
    expect(loadDialect("mysql").name).toBe("mysql")
    expect(loadDialect("sqlite").name).toBe("sqlite")
    expect(loadDialect("mssql").name).toBe("mssql")
  })

  it("throws CliError on an unknown dialect", () => {
    expect(() => loadDialect("oracle")).toThrow(CliError)
  })
})
