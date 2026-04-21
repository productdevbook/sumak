import { describe, expect, it } from "vitest"

import { and, col, eq, lit, or } from "../../src/ast/expression.ts"
import type { BinaryOpNode, ExpressionNode, LiteralNode } from "../../src/ast/nodes.ts"
import { fromCNF, normalizeExpression, toCNF } from "../../src/normalize/expression.ts"

describe("normalizeExpression", () => {
  describe("flatten AND/OR", () => {
    it("flattens nested AND", () => {
      // (a = 1 AND (b = 2 AND c = 3))
      const expr = and(eq(col("a"), lit(1)), and(eq(col("b"), lit(2)), eq(col("c"), lit(3))))
      const result = normalizeExpression(expr)
      // Should be a left-associative chain: ((a=1 AND b=2) AND c=3)
      expect(result.type).toBe("binary_op")
      const r = result as BinaryOpNode
      expect(r.op).toBe("AND")
      expect(r.right.type).toBe("binary_op") // c = 3
    })

    it("flattens nested OR", () => {
      const expr = or(eq(col("a"), lit(1)), or(eq(col("b"), lit(2)), eq(col("c"), lit(3))))
      const result = normalizeExpression(expr)
      expect(result.type).toBe("binary_op")
      expect((result as BinaryOpNode).op).toBe("OR")
    })
  })

  describe("deduplicate predicates", () => {
    it("removes duplicate AND clauses", () => {
      const a = eq(col("a"), lit(1))
      const b = eq(col("b"), lit(2))
      const expr = and(a, and(b, eq(col("a"), lit(1)))) // a=1 AND b=2 AND a=1
      const result = normalizeExpression(expr)

      // Should only have a=1 AND b=2 (two clauses, not three)
      const parts = flattenAndResult(result)
      expect(parts.length).toBe(2)
    })
  })

  describe("simplify tautologies", () => {
    it("x AND true → x", () => {
      const expr = and(eq(col("a"), lit(1)), lit(true) as ExpressionNode)
      const result = normalizeExpression(expr)
      expect(result.type).toBe("binary_op")
      expect((result as BinaryOpNode).op).toBe("=")
    })

    it("x AND false → false", () => {
      const expr = and(eq(col("a"), lit(1)), lit(false) as ExpressionNode)
      const result = normalizeExpression(expr)
      expect(result.type).toBe("literal")
      expect((result as LiteralNode).value).toBe(false)
    })

    it("x OR true → true", () => {
      const expr = or(eq(col("a"), lit(1)), lit(true) as ExpressionNode)
      const result = normalizeExpression(expr)
      expect(result.type).toBe("literal")
      expect((result as LiteralNode).value).toBe(true)
    })

    it("x OR false → x", () => {
      const expr = or(eq(col("a"), lit(1)), lit(false) as ExpressionNode)
      const result = normalizeExpression(expr)
      expect(result.type).toBe("binary_op")
      expect((result as BinaryOpNode).op).toBe("=")
    })
  })

  describe("constant folding", () => {
    it("folds 1 + 2 → 3", () => {
      const expr: BinaryOpNode = {
        type: "binary_op",
        op: "+",
        left: lit(1),
        right: lit(2),
      }
      const result = normalizeExpression(expr)
      expect(result.type).toBe("literal")
      expect((result as LiteralNode).value).toBe(3)
    })

    it("folds 10 * 5 → 50", () => {
      const expr: BinaryOpNode = {
        type: "binary_op",
        op: "*",
        left: lit(10),
        right: lit(5),
      }
      const result = normalizeExpression(expr)
      expect(result.type).toBe("literal")
      expect((result as LiteralNode).value).toBe(50)
    })

    it("does NOT fold `||` — dialect semantics differ (pg/sqlite concat vs mysql OR vs mssql invalid)", () => {
      const expr: BinaryOpNode = {
        type: "binary_op",
        op: "||",
        left: lit("hello "),
        right: lit("world"),
      }
      const result = normalizeExpression(expr)
      // Expression must remain intact so the printer can route to the
      // correct dialect semantics. Folding here would change meaning on
      // MySQL (default sql_mode: `||` = logical OR, not concat).
      expect(result.type).toBe("binary_op")
    })

    it("does not fold division by zero", () => {
      const expr: BinaryOpNode = {
        type: "binary_op",
        op: "/",
        left: lit(10),
        right: lit(0),
      }
      const result = normalizeExpression(expr)
      expect(result.type).toBe("binary_op") // unchanged
    })
  })

  describe("simplify negation", () => {
    it("NOT NOT x → x", () => {
      const inner = eq(col("a"), lit(1))
      const expr: ExpressionNode = {
        type: "unary_op",
        op: "NOT",
        operand: {
          type: "unary_op",
          op: "NOT",
          operand: inner,
          position: "prefix",
        },
        position: "prefix",
      }
      const result = normalizeExpression(expr)
      expect(result.type).toBe("binary_op")
      expect((result as BinaryOpNode).op).toBe("=")
    })

    it("NOT true → false", () => {
      const expr: ExpressionNode = {
        type: "unary_op",
        op: "NOT",
        operand: lit(true),
        position: "prefix",
      }
      const result = normalizeExpression(expr)
      expect(result.type).toBe("literal")
      expect((result as LiteralNode).value).toBe(false)
    })

    it("NOT (x IS NULL) → x IS NOT NULL", () => {
      const expr: ExpressionNode = {
        type: "unary_op",
        op: "NOT",
        operand: { type: "is_null", expr: col("a"), negated: false },
        position: "prefix",
      }
      const result = normalizeExpression(expr)
      expect(result.type).toBe("is_null")
      expect(result.type === "is_null" && result.negated).toBe(true)
    })
  })

  describe("normalize comparison direction", () => {
    it("1 = x → x = 1 (literal on right)", () => {
      const expr = eq(lit(1), col("a"))
      const result = normalizeExpression(expr)
      expect(result.type).toBe("binary_op")
      const r = result as BinaryOpNode
      expect(r.left.type).toBe("column_ref")
      expect(r.right.type).toBe("literal")
    })

    it("5 > x → x < 5 (flips comparison)", () => {
      const expr: BinaryOpNode = {
        type: "binary_op",
        op: ">",
        left: lit(5),
        right: col("a"),
      }
      const result = normalizeExpression(expr)
      const r = result as BinaryOpNode
      expect(r.op).toBe("<")
      expect(r.left.type).toBe("column_ref")
    })
  })

  describe("options", () => {
    it("can disable specific normalizations", () => {
      const expr: BinaryOpNode = {
        type: "binary_op",
        op: "+",
        left: lit(1),
        right: lit(2),
      }
      const result = normalizeExpression(expr, { foldConstants: false })
      expect(result.type).toBe("binary_op") // not folded
    })
  })
})

describe("toCNF / fromCNF", () => {
  it("converts AND to CNF", () => {
    const expr = and(eq(col("a"), lit(1)), eq(col("b"), lit(2)))
    const cnf = toCNF(expr)
    expect(cnf.clauses.length).toBe(2)
    expect(cnf.clauses[0].length).toBe(1)
    expect(cnf.clauses[1].length).toBe(1)
  })

  it("roundtrips through CNF", () => {
    const expr = and(eq(col("a"), lit(1)), eq(col("b"), lit(2)))
    const cnf = toCNF(expr)
    const result = fromCNF(cnf)
    expect(result).toBeDefined()
    expect(result!.type).toBe("binary_op")
  })

  it("handles empty CNF", () => {
    expect(fromCNF({ clauses: [] })).toBeUndefined()
  })

  it("converts OR within AND to CNF", () => {
    // (a = 1 OR a = 2) AND b = 3
    const expr = and(or(eq(col("a"), lit(1)), eq(col("a"), lit(2))), eq(col("b"), lit(3)))
    const cnf = toCNF(expr)
    expect(cnf.clauses.length).toBe(2)
    expect(cnf.clauses[0].length).toBe(2) // a=1 OR a=2
    expect(cnf.clauses[1].length).toBe(1) // b=3
  })
})

// Helper
function flattenAndResult(expr: ExpressionNode): ExpressionNode[] {
  if (expr.type === "binary_op" && (expr as BinaryOpNode).op === "AND") {
    const b = expr as BinaryOpNode
    return [...flattenAndResult(b.left), ...flattenAndResult(b.right)]
  }
  return [expr]
}
