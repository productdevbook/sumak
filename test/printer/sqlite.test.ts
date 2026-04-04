import { describe, expect, it } from "vitest"

import { col, eq, param, star } from "../../src/ast/expression.ts"
import { insert } from "../../src/builder/insert.ts"
import { select } from "../../src/builder/select.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { SqlitePrinter } from "../../src/printer/sqlite.ts"

describe("SqlitePrinter", () => {
  const printer = new SqlitePrinter()

  it("uses ? parameter style", () => {
    const node = select("id")
      .from("users")
      .where(eq(col("id"), param(0, 42)))
      .build()
    const result = printer.print(node)
    expect(result.sql).toContain("?")
    expect(result.params).toEqual([42])
  })

  it("uses double-quote identifiers", () => {
    const node = select("name").from("users").build()
    const result = printer.print(node)
    expect(result.sql).toContain('"name"')
    expect(result.sql).toContain('"users"')
  })

  it("throws on FOR UPDATE", () => {
    const node = select("id").from("users").forUpdate().build()
    expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
  })

  it("supports INSERT with RETURNING", () => {
    const node = insert("users").columns("name").values("Alice").returning(star()).build()
    const result = printer.print(node)
    expect(result.sql).toContain("RETURNING *")
  })

  it("supports ON CONFLICT", () => {
    const node = insert("users")
      .columns("email")
      .values("alice@example.com")
      .onConflictDoNothing("email")
      .build()
    const result = printer.print(node)
    expect(result.sql).toContain("ON CONFLICT")
    expect(result.sql).toContain("DO NOTHING")
  })
})
