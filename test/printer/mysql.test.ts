import { describe, expect, it } from "vitest"

import { col, eq, param } from "../../src/ast/expression.ts"
import { star } from "../../src/ast/expression.ts"
import { insert } from "../../src/builder/insert.ts"
import { select } from "../../src/builder/select.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { MysqlPrinter } from "../../src/printer/mysql.ts"

describe("MysqlPrinter", () => {
  const printer = new MysqlPrinter()

  it("uses ? parameter style", () => {
    const node = select("id")
      .from("users")
      .where(eq(col("id"), param(0, 42)))
      .build()
    const result = printer.print(node)
    expect(result.sql).toContain("?")
    expect(result.sql).not.toContain("$")
    expect(result.params).toEqual([42])
  })

  it("uses backtick identifiers", () => {
    const node = select("name").from("users").build()
    const result = printer.print(node)
    expect(result.sql).toContain("`name`")
    expect(result.sql).toContain("`users`")
  })

  it("escapes backticks in identifiers", () => {
    const node = select("col`name").from("users").build()
    const result = printer.print(node)
    expect(result.sql).toContain("`col``name`")
  })

  it("throws on RETURNING in INSERT", () => {
    const node = insert("users").columns("name").values("Alice").returning(star()).build()
    expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
  })

  it("handles FOR UPDATE", () => {
    const node = select("id").from("users").forUpdate().build()
    const result = printer.print(node)
    expect(result.sql).toContain("FOR UPDATE")
  })
})
