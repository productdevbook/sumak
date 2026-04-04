import { describe, expect, it } from "vitest"
import { PgPrinter } from "../../src/printer/pg.ts"
import { col, lit } from "../../src/ast/expression.ts"
import { createSelectNode } from "../../src/ast/nodes.ts"
import type {
  JsonAccessNode,
  ArrayExprNode,
  SelectNode,
  WindowFunctionNode,
} from "../../src/ast/nodes.ts"

const pg = new PgPrinter()

describe("JsonAccessNode", () => {
  it("prints -> operator", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [
        {
          type: "json_access",
          expr: col("data"),
          path: "name",
          operator: "->",
        } satisfies JsonAccessNode,
      ],
      from: { type: "table_ref", name: "users" },
    }
    const result = pg.print(node)
    expect(result.sql).toContain("->")
    expect(result.sql).toContain("'name'")
  })

  it("prints ->> operator", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [
        {
          type: "json_access",
          expr: col("data"),
          path: "email",
          operator: "->>",
          alias: "user_email",
        } satisfies JsonAccessNode,
      ],
      from: { type: "table_ref", name: "users" },
    }
    const result = pg.print(node)
    expect(result.sql).toContain("->>")
    expect(result.sql).toContain('AS "user_email"')
  })
})

describe("ArrayExprNode", () => {
  it("prints ARRAY constructor", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [
        {
          type: "array_expr",
          elements: [lit(1), lit(2), lit(3)],
        } satisfies ArrayExprNode,
      ],
    }
    const result = pg.print(node)
    expect(result.sql).toBe("SELECT ARRAY[1, 2, 3]")
  })

  it("prints empty array", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [
        {
          type: "array_expr",
          elements: [],
        } satisfies ArrayExprNode,
      ],
    }
    const result = pg.print(node)
    expect(result.sql).toBe("SELECT ARRAY[]")
  })
})

describe("WindowFunctionNode", () => {
  it("prints window function with PARTITION BY and ORDER BY", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [
        {
          type: "window_function",
          fn: { type: "function_call", name: "ROW_NUMBER", args: [] },
          partitionBy: [col("department")],
          orderBy: [{ expr: col("salary"), direction: "DESC" }],
          alias: "rank",
        } satisfies WindowFunctionNode,
      ],
      from: { type: "table_ref", name: "employees" },
    }
    const result = pg.print(node)
    expect(result.sql).toContain("ROW_NUMBER()")
    expect(result.sql).toContain("OVER")
    expect(result.sql).toContain("PARTITION BY")
    expect(result.sql).toContain("ORDER BY")
    expect(result.sql).toContain('AS "rank"')
  })

  it("prints window function with frame spec", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [
        {
          type: "window_function",
          fn: { type: "function_call", name: "SUM", args: [col("amount")] },
          partitionBy: [],
          orderBy: [{ expr: col("date"), direction: "ASC" }],
          frame: {
            kind: "ROWS",
            start: { type: "unbounded_preceding" },
            end: { type: "current_row" },
          },
        } satisfies WindowFunctionNode,
      ],
    }
    const result = pg.print(node)
    expect(result.sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW")
  })

  it("prints window function with numeric frame bounds", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [
        {
          type: "window_function",
          fn: { type: "function_call", name: "AVG", args: [col("price")] },
          partitionBy: [],
          orderBy: [{ expr: col("id"), direction: "ASC" }],
          frame: {
            kind: "ROWS",
            start: { type: "preceding", value: 3 },
            end: { type: "following", value: 3 },
          },
        } satisfies WindowFunctionNode,
      ],
    }
    const result = pg.print(node)
    expect(result.sql).toContain("ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING")
  })

  it("prints window function without partition", () => {
    const node: SelectNode = {
      ...createSelectNode(),
      columns: [
        {
          type: "window_function",
          fn: { type: "function_call", name: "COUNT", args: [{ type: "star" }] },
          partitionBy: [],
          orderBy: [],
        } satisfies WindowFunctionNode,
      ],
    }
    const result = pg.print(node)
    expect(result.sql).toContain("COUNT(*)")
    expect(result.sql).toContain("OVER ()")
  })
})
