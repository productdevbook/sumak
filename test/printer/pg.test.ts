import { describe, expect, it } from "vitest"
import { PgPrinter } from "../../src/printer/pg.ts"
import { select } from "../../src/builder/select.ts"
import { insert } from "../../src/builder/insert.ts"
import { col, eq, param, star } from "../../src/ast/expression.ts"

describe("PgPrinter", () => {
  const printer = new PgPrinter()

  it("uses $N parameter style", () => {
    const node = select("id")
      .from("users")
      .where(eq(col("id"), param(0, 42)))
      .build()
    const result = printer.print(node)
    expect(result.sql).toContain("$1")
    expect(result.params).toEqual([42])
  })

  it("uses double-quote identifiers", () => {
    const node = select("user name").from("my table").build()
    const result = printer.print(node)
    expect(result.sql).toContain('"user name"')
    expect(result.sql).toContain('"my table"')
  })

  it("handles multiple params with correct numbering", () => {
    const node = insert("users")
      .columns("name", "email", "age")
      .values("Alice", "alice@example.com", 30)
      .build()
    const result = printer.print(node)
    expect(result.sql).toContain("$1")
    expect(result.sql).toContain("$2")
    expect(result.sql).toContain("$3")
    expect(result.params).toEqual(["Alice", "alice@example.com", 30])
  })

  it("supports RETURNING", () => {
    const node = insert("users").columns("name").values("Alice").returning(star()).build()
    const result = printer.print(node)
    expect(result.sql).toContain("RETURNING *")
  })

  it("escapes double quotes in identifiers", () => {
    const node = select('col"name').from("users").build()
    const result = printer.print(node)
    expect(result.sql).toContain('"col""name"')
  })
})
