import { describe, expect, it } from "vitest"

import { col, eq, lit } from "../../src/ast/expression.ts"
import { createSelectNode } from "../../src/ast/nodes.ts"
import type { ColumnRefNode, ExpressionNode } from "../../src/ast/nodes.ts"
import { ASTTransformer } from "../../src/ast/transformer.ts"

class UpperCaseColumnTransformer extends ASTTransformer {
  override transformExpression(node: ExpressionNode): ExpressionNode {
    if (node.type === "column_ref") {
      return { ...node, column: node.column.toUpperCase() } as ColumnRefNode
    }
    return super.transformExpression(node)
  }
}

describe("ASTTransformer", () => {
  it("transforms select columns", () => {
    const transformer = new UpperCaseColumnTransformer()
    const node = { ...createSelectNode(), columns: [col("name"), col("email")] }

    const result = transformer.transformSelect(node)
    expect((result.columns[0] as ColumnRefNode).column).toBe("NAME")
    expect((result.columns[1] as ColumnRefNode).column).toBe("EMAIL")
  })

  it("transforms where clause", () => {
    const transformer = new UpperCaseColumnTransformer()
    const node = { ...createSelectNode(), where: eq(col("id"), lit(1)) }

    const result = transformer.transformSelect(node)
    expect(result.where).toBeDefined()
    if (result.where?.type === "binary_op") {
      expect((result.where.left as ColumnRefNode).column).toBe("ID")
    }
  })

  it("returns node unchanged with base transformer", () => {
    const transformer = new ASTTransformer()
    const node = { ...createSelectNode(), columns: [col("name")] }

    const result = transformer.transformSelect(node)
    expect((result.columns[0] as ColumnRefNode).column).toBe("name")
  })

  it("transforms insert values", () => {
    const transformer = new UpperCaseColumnTransformer()
    const result = transformer.transformInsert({
      type: "insert",
      table: { type: "table_ref", name: "users" },
      columns: ["name"],
      values: [[col("other_col")]],
      returning: [],
      ctes: [],
    })
    expect((result.values[0]![0] as ColumnRefNode).column).toBe("OTHER_COL")
  })

  it("transforms update set values", () => {
    const transformer = new UpperCaseColumnTransformer()
    const result = transformer.transformUpdate({
      type: "update",
      table: { type: "table_ref", name: "users" },
      set: [{ column: "name", value: col("old_name") }],
      returning: [],
      ctes: [],
    })
    expect((result.set[0]!.value as ColumnRefNode).column).toBe("OLD_NAME")
  })

  it("transforms delete where clause", () => {
    const transformer = new UpperCaseColumnTransformer()
    const result = transformer.transformDelete({
      type: "delete",
      table: { type: "table_ref", name: "users" },
      where: col("status"),
      returning: [],
      ctes: [],
    })
    expect((result.where as ColumnRefNode).column).toBe("STATUS")
  })
})
