import { describe, expect, it } from "vitest"

import { cast, col, fn, lit, raw, star } from "../../src/ast/expression.ts"
import { createSelectNode } from "../../src/ast/nodes.ts"
import type { SelectNode } from "../../src/ast/nodes.ts"
import { BasePrinter } from "../../src/printer/base.ts"

describe("BasePrinter", () => {
  const printer = new BasePrinter("pg")

  function withColumns(
    ...columns: Parameters<typeof col>[] extends never[] ? any[] : any[]
  ): SelectNode {
    return { ...createSelectNode(), columns }
  }

  it("prints NULL literal", () => {
    const node = withColumns(lit(null))
    expect(printer.print(node).sql).toBe("SELECT NULL")
  })

  it("prints boolean literal", () => {
    const node = withColumns(lit(true))
    expect(printer.print(node).sql).toBe("SELECT TRUE")
  })

  it("prints number literal", () => {
    const node = withColumns(lit(42))
    expect(printer.print(node).sql).toBe("SELECT 42")
  })

  it("prints string literal with escaping", () => {
    const node = withColumns(lit("it's"))
    expect(printer.print(node).sql).toBe("SELECT 'it''s'")
  })

  it("prints function call", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [fn("COUNT", [star()])],
      from: { type: "table_ref", name: "users" },
    }
    expect(printer.print(node).sql).toBe('SELECT COUNT(*) FROM "users"')
  })

  it("prints function with alias", () => {
    const node = withColumns(fn("COUNT", [star()], "total"))
    expect(printer.print(node).sql).toContain('AS "total"')
  })

  it("prints CAST expression", () => {
    const node = withColumns(cast(col("price"), "INTEGER"))
    expect(printer.print(node).sql).toContain("CAST")
    expect(printer.print(node).sql).toContain("INTEGER")
  })

  it("prints raw SQL", () => {
    const node = withColumns(raw("NOW()"))
    expect(printer.print(node).sql).toBe("SELECT NOW()")
  })

  it("prints raw SQL with params", () => {
    const node = withColumns(raw("$1 + $2", [1, 2]))
    const result = printer.print(node)
    expect(result.sql).toBe("SELECT $1 + $2")
    expect(result.params).toEqual([1, 2])
  })

  it("prints star with table prefix", () => {
    const node = withColumns(star("users"))
    expect(printer.print(node).sql).toContain('"users".*')
  })

  it("prints column with alias", () => {
    const node = withColumns({ type: "column_ref" as const, column: "name", alias: "user_name" })
    expect(printer.print(node).sql).toContain('AS "user_name"')
  })

  it("prints table with schema", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: { type: "table_ref", name: "users", schema: "public" },
    }
    const result = printer.print(node)
    expect(result.sql).toContain('"public"."users"')
  })

  it("resets params between prints", () => {
    const node = withColumns(raw("$1", [42]))
    const r1 = printer.print(node)
    const r2 = printer.print(node)
    expect(r1.params).toEqual([42])
    expect(r2.params).toEqual([42])
  })

  it("prints CASE expression", () => {
    const node = withColumns({
      type: "case" as const,
      whens: [{ condition: lit(true), result: lit("yes") }],
      else_: lit("no"),
    })
    const result = printer.print(node)
    expect(result.sql).toContain("CASE")
    expect(result.sql).toContain("WHEN")
    expect(result.sql).toContain("THEN")
    expect(result.sql).toContain("ELSE")
    expect(result.sql).toContain("END")
  })
})
