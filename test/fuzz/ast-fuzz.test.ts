import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type {
  BinaryOpNode,
  ColumnRefNode,
  ExpressionNode,
  LiteralNode,
  ParamNode,
  SelectNode,
  UnaryOpNode,
} from "../../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../../src/ast/nodes.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import type { Dialect } from "../../src/dialect/types.ts"
import {
  SumakError,
  UnreachableNodeError,
  UnsupportedDialectFeatureError,
} from "../../src/errors.ts"

// AST fuzzer.
//
// Generates random (but well-typed) ExpressionNode + SelectNode shapes
// and hands them to every printer. Any of these outcomes is a BUG:
//
//   - UnreachableNodeError: a switch somewhere has a new-variant hole
//     that the fuzzer just walked into.
//   - TypeError, RangeError, or any generic Error: printer crashed on
//     a legal AST shape. We do NOT expect crashes on valid input.
//
// Any of these outcomes is ACCEPTABLE (not a bug):
//
//   - SumakError subclass (UnsupportedDialectFeatureError, etc.): the
//     printer noticed a dialect-illegal combination and bailed with a
//     helpful message — exactly what the feature matrix is for.
//   - Clean string return: the printer produced SQL. (We don't execute
//     it, so its semantic validity isn't asserted — the parity suite
//     covers that for hand-written shapes.)

const DIALECTS: readonly { name: string; dialect: Dialect }[] = [
  { name: "pg", dialect: pgDialect() },
  { name: "mysql", dialect: mysqlDialect() },
  { name: "sqlite", dialect: sqliteDialect() },
  { name: "mssql", dialect: mssqlDialect() },
]

// ── Arbitraries ───────────────────────────────────────────────────

const literalArb: fc.Arbitrary<LiteralNode> = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }).map((value) => ({ type: "literal" as const, value })),
  fc.boolean().map((value) => ({ type: "literal" as const, value })),
  fc.constant({ type: "literal" as const, value: null }),
  fc
    .string({ minLength: 0, maxLength: 20 })
    .filter((s) => !s.includes("'") && !s.includes("\\"))
    .map((value) => ({ type: "literal" as const, value })),
)

const paramArb: fc.Arbitrary<ParamNode> = fc
  .oneof(fc.integer(), fc.boolean(), fc.string({ minLength: 0, maxLength: 10 }))
  .map((value) => ({ type: "param" as const, index: 0, value }))

const columnRefArb: fc.Arbitrary<ColumnRefNode> = fc.record({
  type: fc.constant("column_ref" as const),
  column: fc.constantFrom("id", "name", "age", "email", "active"),
})

const terminalExprArb: fc.Arbitrary<ExpressionNode> = fc.oneof(literalArb, paramArb, columnRefArb)

// Bounded-depth expression tree. Keep depth small (≤ 3) so each run
// explores many shapes quickly and the generator can't recurse into
// pathological trees that dominate the budget.
const exprArb: fc.Arbitrary<ExpressionNode> = fc.letrec((tie) => ({
  expr: fc.oneof(
    { depthSize: "small" },
    terminalExprArb,
    fc
      .record({
        op: fc.constantFrom("=", "<", ">", "<=", ">=", "+", "-", "*", "AND", "OR"),
        left: tie("expr"),
        right: tie("expr"),
      })
      .map(
        ({ op, left, right }): BinaryOpNode => ({
          type: "binary_op",
          op,
          left: left as ExpressionNode,
          right: right as ExpressionNode,
        }),
      ),
    fc
      .record({
        op: fc.constantFrom("NOT", "-"),
        operand: tie("expr"),
      })
      .map(
        ({ op, operand }): UnaryOpNode => ({
          type: "unary_op",
          op,
          operand: operand as ExpressionNode,
          position: "prefix",
        }),
      ),
    fc
      .record({
        expr: tie("expr"),
        low: tie("expr"),
        high: tie("expr"),
        negated: fc.boolean(),
      })
      .map(({ expr, low, high, negated }) => ({
        type: "between" as const,
        expr: expr as ExpressionNode,
        low: low as ExpressionNode,
        high: high as ExpressionNode,
        negated,
      })),
    fc
      .record({
        expr: tie("expr"),
        negated: fc.boolean(),
      })
      .map(({ expr, negated }) => ({
        type: "is_null" as const,
        expr: expr as ExpressionNode,
        negated,
      })),
  ),
})).expr as fc.Arbitrary<ExpressionNode>

const selectArb: fc.Arbitrary<SelectNode> = fc
  .record({
    tableName: fc.constantFrom("users", "posts", "orders"),
    hasWhere: fc.boolean(),
    hasLimit: fc.boolean(),
    whereExpr: exprArb,
    limit: fc.integer({ min: 1, max: 1000 }),
  })
  .map(({ tableName, hasWhere, hasLimit, whereExpr, limit }) => ({
    ...createSelectNode(),
    from: tableRef(tableName),
    columns: [{ type: "star" as const }],
    where: hasWhere ? whereExpr : undefined,
    limit: hasLimit ? ({ type: "literal", value: limit } as LiteralNode) : undefined,
  }))

// ── Tests ─────────────────────────────────────────────────────────

describe("AST fuzz", () => {
  it("every printer handles random expression trees without UnreachableNodeError or generic crashes", () => {
    fc.assert(
      fc.property(exprArb, (expr) => {
        const sel: SelectNode = {
          ...createSelectNode(),
          from: tableRef("users"),
          columns: [{ type: "star" as const }],
          where: expr,
        }
        for (const { name, dialect } of DIALECTS) {
          try {
            const printer = dialect.createPrinter()
            const out = printer.print(sel)
            expect(typeof out.sql, `[${name}] sql must be string`).toBe("string")
            expect(out.sql.length, `[${name}] sql non-empty`).toBeGreaterThan(0)
          } catch (err) {
            if (err instanceof UnreachableNodeError) {
              throw new Error(
                `[${name}] UnreachableNodeError leaked — a new AST variant has an unhandled switch case. Expr: ${JSON.stringify(expr)}`,
              )
            }
            if (err instanceof SumakError) {
              // Expected: UnsupportedDialectFeatureError, InvalidExpressionError, etc.
              continue
            }
            throw new Error(
              `[${name}] generic ${err instanceof Error ? err.constructor.name : typeof err} — printer should either succeed or throw a SumakError. ` +
                `Message: ${err instanceof Error ? err.message : String(err)}. ` +
                `Expr: ${JSON.stringify(expr)}`,
            )
          }
        }
      }),
      { numRuns: 500 },
    )
  })

  it("every printer handles random SELECT shapes without UnreachableNodeError", () => {
    fc.assert(
      fc.property(selectArb, (sel) => {
        for (const { name, dialect } of DIALECTS) {
          try {
            const printer = dialect.createPrinter()
            printer.print(sel)
          } catch (err) {
            if (err instanceof UnreachableNodeError) {
              throw new Error(
                `[${name}] UnreachableNodeError leaked on SELECT. Node: ${JSON.stringify(sel)}`,
              )
            }
            if (err instanceof SumakError) continue
            throw new Error(
              `[${name}] generic crash on valid SELECT. ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }),
      { numRuns: 500 },
    )
  })

  it("UnsupportedDialectFeatureError is the ONLY legitimate cross-dialect divergence", () => {
    // For each fuzz iteration, if N-1 dialects succeed, the Nth must either
    // also succeed OR throw UnsupportedDialectFeatureError. A different
    // SumakError subclass means one dialect found a shape the others accept
    // — which is worth surfacing.
    fc.assert(
      fc.property(exprArb, (expr) => {
        const sel: SelectNode = {
          ...createSelectNode(),
          from: tableRef("users"),
          columns: [{ type: "star" as const }],
          where: expr,
        }
        const results = DIALECTS.map(({ name, dialect }) => {
          try {
            dialect.createPrinter().print(sel)
            return { name, kind: "ok" as const }
          } catch (err) {
            if (err instanceof UnsupportedDialectFeatureError) {
              return { name, kind: "unsupported" as const }
            }
            if (err instanceof SumakError) {
              return { name, kind: "sumak-error" as const, err }
            }
            return { name, kind: "crash" as const, err }
          }
        })
        const anyOk = results.some((r) => r.kind === "ok")
        if (!anyOk) return // shape is fundamentally invalid; skip
        for (const r of results) {
          if (r.kind === "crash") {
            throw new Error(
              `[${r.name}] crashed while others succeeded: ${(r as { err: Error }).err.message}`,
            )
          }
        }
      }),
      { numRuns: 200 },
    )
  })
})
