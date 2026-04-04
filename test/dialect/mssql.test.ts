import { describe, expect, it } from "vitest"

import { select } from "../../src/builder/select.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"

describe("mssqlDialect", () => {
  it("creates a dialect with name mssql", () => {
    const dialect = mssqlDialect()
    expect(dialect.name).toBe("mssql")
  })

  it("creates a MssqlPrinter", () => {
    const dialect = mssqlDialect()
    const printer = dialect.createPrinter()
    const result = printer.print(select("id").from("users").build())
    expect(result.sql).toContain("[id]")
    expect(result.sql).toContain("[users]")
  })
})
