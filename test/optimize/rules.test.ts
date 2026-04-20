import { describe, expect, it } from "vitest"

import { col, eq, lit, param } from "../../src/ast/expression.ts"
import type { BinaryOpNode, SelectNode } from "../../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../../src/ast/nodes.ts"
import { predicatePushdown, removeWhereTrue, subqueryFlattening } from "../../src/optimize/rules.ts"

describe("predicatePushdown", () => {
  it("pushes single-table WHERE into JOIN ON", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users", "u"),
      columns: [{ type: "star" }],
      joins: [
        {
          type: "join",
          joinType: "INNER",
          table: tableRef("posts", "p"),
          on: eq(col("id", "u"), col("user_id", "p")),
        },
      ],
      where: eq(col("active", "p"), param(0, true)),
    }

    expect(predicatePushdown.match(node)).toBe(true)
    const result = predicatePushdown.apply(node) as SelectNode

    // WHERE should be removed (pushed into JOIN)
    expect(result.where).toBeUndefined()
    // JOIN ON should contain the pushed predicate
    const on = result.joins[0].on! as BinaryOpNode
    expect(on.op).toBe("AND")
  })

  it("keeps WHERE for multi-table predicates", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users", "u"),
      columns: [{ type: "star" }],
      joins: [
        {
          type: "join",
          joinType: "INNER",
          table: tableRef("posts", "p"),
          on: eq(col("id", "u"), col("user_id", "p")),
        },
      ],
      // WHERE references both u and p — can't push
      where: eq(col("name", "u"), col("title", "p")),
    }

    expect(predicatePushdown.match(node)).toBe(true)
    const result = predicatePushdown.apply(node) as SelectNode
    expect(result.where).toBeDefined() // still in WHERE
  })

  it("does not match SELECT without joins", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: eq(col("id"), lit(1)),
    }
    expect(predicatePushdown.match(node)).toBe(false)
  })
})

describe("subqueryFlattening", () => {
  it("flattens SELECT * FROM (SELECT * FROM t)", () => {
    const inner: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
    }
    const outer: SelectNode = {
      ...createSelectNode(),
      from: { type: "subquery", query: inner, alias: "u" },
      columns: [{ type: "star" }],
    }

    expect(subqueryFlattening.match(outer)).toBe(true)
    const result = subqueryFlattening.apply(outer) as SelectNode
    expect(result.from?.type).toBe("table_ref")
    if (result.from?.type === "table_ref") {
      expect(result.from.name).toBe("users")
      // Outer alias must survive — callers may qualify columns as `u.col`.
      expect(result.from.alias).toBe("u")
    }
  })

  it("does not flatten when inner FROM is itself a subquery (alias would be lost)", () => {
    const innermost: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
    }
    const inner: SelectNode = {
      ...createSelectNode(),
      from: { type: "subquery", query: innermost, alias: "i" },
      columns: [{ type: "star" }],
    }
    const outer: SelectNode = {
      ...createSelectNode(),
      from: { type: "subquery", query: inner, alias: "o" },
      columns: [{ type: "star" }],
    }
    expect(subqueryFlattening.match(outer)).toBe(false)
  })

  it("does not flatten subquery with WHERE", () => {
    const inner: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: eq(col("active"), lit(true)),
    }
    const outer: SelectNode = {
      ...createSelectNode(),
      from: { type: "subquery", query: inner, alias: "u" },
      columns: [{ type: "star" }],
    }

    expect(subqueryFlattening.match(outer)).toBe(false)
  })

  it("does not flatten subquery with LIMIT", () => {
    const inner: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      limit: lit(10),
    }
    const outer: SelectNode = {
      ...createSelectNode(),
      from: { type: "subquery", query: inner, alias: "u" },
      columns: [{ type: "star" }],
    }

    expect(subqueryFlattening.match(outer)).toBe(false)
  })
})

describe("removeWhereTrue", () => {
  it("removes WHERE true from SELECT", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: { type: "literal", value: true },
    }

    expect(removeWhereTrue.match(node)).toBe(true)
    const result = removeWhereTrue.apply(node) as SelectNode
    expect(result.where).toBeUndefined()
  })

  it("removes WHERE true from UPDATE", () => {
    const node = {
      type: "update" as const,
      table: tableRef("users"),
      set: [{ column: "name", value: lit("Bob") }],
      where: { type: "literal" as const, value: true },
      returning: [],
      joins: [],
      ctes: [],
    }

    expect(removeWhereTrue.match(node)).toBe(true)
    const result = removeWhereTrue.apply(node)
    expect(result.type === "update" && result.where).toBeUndefined()
  })

  it("does not match WHERE false", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      from: tableRef("users"),
      columns: [{ type: "star" }],
      where: { type: "literal", value: false },
    }
    expect(removeWhereTrue.match(node)).toBe(false)
  })
})
