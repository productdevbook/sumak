import { describe, expect, it } from "vitest"

import { col, eq, param } from "../../src/ast/expression.ts"
import { createSelectNode, tableRef } from "../../src/ast/nodes.ts"
import type { SelectNode } from "../../src/ast/nodes.ts"
import {
  collectPlaceholders,
  compileQuery,
  isPlaceholder,
  placeholder,
} from "../../src/builder/compiled.ts"
import { PgPrinter } from "../../src/printer/pg.ts"

describe("placeholder", () => {
  it("creates a placeholder marker", () => {
    const p = placeholder("userId")
    expect(isPlaceholder(p)).toBe(true)
    expect(p.name).toBe("userId")
  })

  it("non-placeholder values return false", () => {
    expect(isPlaceholder(42)).toBe(false)
    expect(isPlaceholder("hello")).toBe(false)
    expect(isPlaceholder(null)).toBe(false)
    expect(isPlaceholder({})).toBe(false)
  })
})

describe("compileQuery", () => {
  it("creates a reusable compiled query", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [
        { type: "column_ref", column: "id" },
        { type: "column_ref", column: "name" },
      ],
      where: eq(col("id"), param(0, placeholder("userId"))),
    }

    const printer = new PgPrinter()
    const fn = compileQuery<{ userId: number }>(node, printer)

    expect(fn.sql).toContain("SELECT")
    expect(fn.sql).toContain('"users"')

    const r1 = fn({ userId: 42 })
    expect(r1.sql).toBe(fn.sql) // same SQL
    expect(r1.params).toContain(42)

    const r2 = fn({ userId: 99 })
    expect(r2.sql).toBe(fn.sql) // still same SQL
    expect(r2.params).toContain(99)
  })

  it("works with no placeholders (static query)", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: eq(col("id"), param(0, 1)),
    }

    const printer = new PgPrinter()
    const fn = compileQuery<Record<string, never>>(node, printer)

    const result = fn({} as any)
    expect(result.sql).toBe(fn.sql)
    expect(result.params).toContain(1)
  })

  it("handles multiple placeholders", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: {
        type: "binary_op",
        op: "AND",
        left: eq(col("name"), param(0, placeholder("name"))),
        right: eq(col("age"), param(0, placeholder("age"))),
      },
    }

    const printer = new PgPrinter()
    const fn = compileQuery<{ name: string; age: number }>(node, printer)

    const result = fn({ name: "Alice", age: 30 })
    expect(result.params).toContain("Alice")
    expect(result.params).toContain(30)
  })

  it("uses compileFn when provided", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
    }

    const printer = new PgPrinter()
    let compileCalled = false
    const compileFn = (n: any) => {
      compileCalled = true
      return printer.print(n)
    }

    compileQuery(node, printer, compileFn)
    expect(compileCalled).toBe(true)
  })
})

describe("collectPlaceholders", () => {
  it("finds placeholder names in AST", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: {
        type: "binary_op",
        op: "AND",
        left: eq(col("name"), param(0, placeholder("name"))),
        right: eq(col("age"), param(0, placeholder("age"))),
      },
    }

    const names = collectPlaceholders(node)
    expect(names).toContain("name")
    expect(names).toContain("age")
    expect(names.length).toBe(2)
  })

  it("deduplicates placeholder names", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: {
        type: "binary_op",
        op: "AND",
        left: eq(col("id"), param(0, placeholder("id"))),
        right: eq(col("ref"), param(0, placeholder("id"))),
      },
    }

    const names = collectPlaceholders(node)
    expect(names).toEqual(["id"])
  })

  it("returns empty array when no placeholders", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
    }
    expect(collectPlaceholders(node)).toEqual([])
  })
})
