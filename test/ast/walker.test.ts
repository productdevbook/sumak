import { describe, expect, it } from "vitest"

import { col, eq, exists, lit } from "../../src/ast/expression.ts"
import type {
  ColumnRefNode,
  ExpressionNode,
  SelectNode,
  TableRefNode,
} from "../../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../../src/ast/nodes.ts"
import { ASTWalker } from "../../src/ast/walker.ts"

class IdentityWalker extends ASTWalker {}

class TableRenamingWalker extends ASTWalker {
  constructor(private readonly rename: (t: string) => string) {
    super()
  }
  override visitTableRef(table: TableRefNode): TableRefNode {
    return { ...table, name: this.rename(table.name) }
  }
  override visitSelect(node: SelectNode): SelectNode {
    const base = super.visitSelect(node)
    if (base.from?.type === "table_ref") {
      const from = this.visitTableRef(base.from)
      if (from !== base.from) return { ...base, from }
    }
    return base
  }
}

describe("ASTWalker", () => {
  describe("identity preservation", () => {
    it("returns the exact same node when no subclass rewrites anything", () => {
      const w = new IdentityWalker()
      const sel: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [col("id"), col("name")],
        where: eq(col("active"), lit(true)),
      }
      const out = w.visitSelect(sel)
      expect(out).toBe(sel)
    })

    it("preserves identity through nested subqueries + EXISTS", () => {
      const w = new IdentityWalker()
      const inner: SelectNode = {
        ...createSelectNode(),
        from: tableRef("posts"),
        columns: [col("id")],
      }
      const outer: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        where: exists(inner),
      }
      const out = w.visitSelect(outer)
      expect(out).toBe(outer)
    })
  })

  describe("deep traversal", () => {
    it("reaches column refs inside WHERE EXISTS (inner SELECT WHERE …)", () => {
      // Track every column this walker sees — proves that a subclass
      // overriding only visitExpression lights up on columns inside a
      // nested EXISTS subquery.
      const seen: string[] = []
      class ColCollector extends ASTWalker {
        override visitExpression(expr: ExpressionNode): ExpressionNode {
          if (expr.type === "column_ref") seen.push(expr.column)
          return super.visitExpression(expr)
        }
      }
      const inner: SelectNode = {
        ...createSelectNode(),
        from: tableRef("posts"),
        where: eq(col("user_id"), col("outer_id")),
      }
      const outer: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        where: exists(inner),
      }
      new ColCollector().visitSelect(outer)
      expect(seen).toContain("user_id")
      expect(seen).toContain("outer_id")
    })
  })

  describe("rewriting", () => {
    it("replaces column refs in WHERE + columns list", () => {
      class Upper extends ASTWalker {
        override visitExpression(expr: ExpressionNode): ExpressionNode {
          if (expr.type === "column_ref") {
            return { ...expr, column: expr.column.toUpperCase() }
          }
          return super.visitExpression(expr)
        }
      }
      const sel: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [col("name")],
        where: eq(col("id"), lit(1)),
      }
      const out = new Upper().visitSelect(sel)
      expect((out.columns[0] as ColumnRefNode).column).toBe("NAME")
      if (out.where?.type === "binary_op") {
        expect((out.where.left as ColumnRefNode).column).toBe("ID")
      }
    })

    it("produces a new parent only when a child changed", () => {
      class RewriteOnce extends ASTWalker {
        count = 0
        override visitExpression(expr: ExpressionNode): ExpressionNode {
          if (expr.type === "column_ref" && expr.column === "target") {
            this.count++
            return { ...expr, column: "renamed" }
          }
          return super.visitExpression(expr)
        }
      }
      const sel: SelectNode = {
        ...createSelectNode(),
        from: tableRef("users"),
        columns: [col("untouched"), col("target"), col("other")],
      }
      const w = new RewriteOnce()
      const out = w.visitSelect(sel)
      expect(w.count).toBe(1)
      expect(out).not.toBe(sel)
      // Untouched column keeps its exact reference.
      expect(out.columns[0]).toBe(sel.columns[0])
      expect(out.columns[2]).toBe(sel.columns[2])
      // Rewritten column is new.
      expect(out.columns[1]).not.toBe(sel.columns[1])
      expect((out.columns[1] as ColumnRefNode).column).toBe("renamed")
    })
  })

  describe("table rewriting", () => {
    it("prefixes table names via visitTableRef override", () => {
      const w = new TableRenamingWalker((n) => `public.${n}`)
      const sel: SelectNode = { ...createSelectNode(), from: tableRef("users") }
      const out = w.visitSelect(sel)
      expect((out.from as TableRefNode).name).toBe("public.users")
    })
  })
})
