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
import { SumakError } from "../../src/errors.ts"
import { normalizeExpression } from "../../src/normalize/expression.ts"
import { normalizeQuery } from "../../src/normalize/query.ts"
import { optimize } from "../../src/optimize/optimizer.ts"

// Property-based tests for the normalize / optimize / print
// pipeline. The structural fuzzer in `ast-fuzz.test.ts` asserts that
// every dialect printer survives random ASTs without crashing; the
// properties here assert *invariants* that should hold across
// arbitrary inputs:
//
//   - normalize idempotence: a second normalize pass over an
//     already-normalized expression should be a no-op (or at least
//     produce a structurally equal result).
//
//   - optimize fixpoint: the rewrite-rules optimizer claims to run
//     to fixed point. Running it again over its own output should
//     produce a structurally equal result.
//
//   - printer determinism: the same AST printed twice through fresh
//     printers must produce identical SQL + params. Hidden mutable
//     state — a global param counter, a memoization cache that
//     survives across instances, etc. — would surface as a property
//     violation.

// ── Arbitraries (mirror the simpler shapes from ast-fuzz.test.ts) ─

const literalArb: fc.Arbitrary<LiteralNode> = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }).map((value) => ({ type: "literal" as const, value })),
  fc.boolean().map((value) => ({ type: "literal" as const, value })),
  fc.constant({ type: "literal" as const, value: null }),
)

const paramArb: fc.Arbitrary<ParamNode> = fc
  .oneof(fc.integer(), fc.boolean(), fc.string({ minLength: 0, maxLength: 10 }))
  .map((value) => ({ type: "param" as const, index: 0, value }))

const columnRefArb: fc.Arbitrary<ColumnRefNode> = fc.record({
  type: fc.constant("column_ref" as const),
  column: fc.constantFrom("id", "name", "age", "active"),
})

const terminalExprArb: fc.Arbitrary<ExpressionNode> = fc.oneof(literalArb, paramArb, columnRefArb)

const exprArb: fc.Arbitrary<ExpressionNode> = fc.letrec((tie) => ({
  expr: fc.oneof(
    { depthSize: "small" },
    terminalExprArb,
    fc
      .record({
        op: fc.constantFrom("=", "<", ">", "<=", ">=", "AND", "OR"),
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
    fc.record({ op: fc.constant("NOT" as const), operand: tie("expr") }).map(
      ({ op, operand }): UnaryOpNode => ({
        type: "unary_op",
        op,
        operand: operand as ExpressionNode,
        position: "prefix",
      }),
    ),
  ),
})).expr as fc.Arbitrary<ExpressionNode>

const selectArb: fc.Arbitrary<SelectNode> = fc
  .record({
    tableName: fc.constantFrom("users", "posts", "orders"),
    hasWhere: fc.boolean(),
    whereExpr: exprArb,
  })
  .map(({ tableName, hasWhere, whereExpr }) => ({
    ...createSelectNode(),
    from: tableRef(tableName),
    columns: [{ type: "star" as const }],
    where: hasWhere ? whereExpr : undefined,
  }))

const DIALECTS = [
  { name: "pg", dialect: pgDialect() },
  { name: "mysql", dialect: mysqlDialect() },
  { name: "sqlite", dialect: sqliteDialect() },
  { name: "mssql", dialect: mssqlDialect() },
] as const

describe("normalize idempotence (expression)", () => {
  // `normalizeExpression` runs its sub-pass sequence to fixed point
  // internally (see the `NORMALIZE_FIXPOINT_PASSES` loop in
  // `src/normalize/expression.ts`), so a second call must be a no-op
  // — `normalizeExpression(normalizeExpression(x))` ≡
  // `normalizeExpression(x)` for all inputs. The original (single-
  // sweep) implementation failed this within 81 random ASTs; the
  // fuzz fence stays here so future refactors can't accidentally
  // regress to single-sweep semantics.
  it("normalizeExpression(normalize(x)) ≡ normalizeExpression(x) for random ASTs", () => {
    fc.assert(
      fc.property(exprArb, (expr) => {
        const once = normalizeExpression(expr)
        const twice = normalizeExpression(once)
        expect(twice).toEqual(once)
      }),
      { numRuns: 300 },
    )
  })
})

describe("normalize idempotence (query)", () => {
  it("normalizeQuery(normalize(q)) ≡ normalizeQuery(q) for random SELECTs", () => {
    fc.assert(
      fc.property(selectArb, (sel) => {
        const once = normalizeQuery(sel)
        const twice = normalizeQuery(once)
        expect(twice).toEqual(once)
      }),
      { numRuns: 200 },
    )
  })
})

describe("optimize fixpoint", () => {
  // The optimizer claims to run rewrite rules to fixed point. The
  // contract: `optimize(optimize(x))` must produce an output
  // structurally equal to `optimize(x)`. Catches rules that
  // accidentally don't terminate, or terminate at different shapes
  // depending on how many times they run.
  it("optimize(optimize(q)) ≡ optimize(q) for random SELECTs", () => {
    fc.assert(
      fc.property(selectArb, (sel) => {
        const once = optimize(sel)
        const twice = optimize(once)
        expect(twice).toEqual(once)
      }),
      { numRuns: 200 },
    )
  })
})

describe("printer determinism", () => {
  // The same AST, printed twice through fresh printers, must produce
  // identical SQL + params. Catches:
  //   - global mutable state (param counter, identifier cache, etc.)
  //   - hidden memoization that survives across printer instances
  //   - any path that flips on the second call (e.g. lazy init that
  //     records into a shared map on first run)
  it.each(DIALECTS)("$name — same AST, fresh printers → same output", ({ dialect }) => {
    fc.assert(
      fc.property(selectArb, (sel) => {
        let first: { sql: string; params: readonly unknown[] }
        try {
          first = dialect.createPrinter().print(sel)
        } catch (err) {
          // SumakError (UnsupportedDialectFeatureError, etc.) is a legit
          // refusal — the AST is dialect-illegal, both printers will
          // refuse identically. Skip those iterations.
          if (err instanceof SumakError) return
          throw err
        }
        const second = dialect.createPrinter().print(sel)
        expect(second.sql).toBe(first.sql)
        expect(second.params).toEqual(first.params)
      }),
      { numRuns: 150 },
    )
  })
})

describe("printer param indexing", () => {
  // The printer assigns params $1, $2, … in the order they appear in
  // the AST walk. The published params array MUST have exactly as
  // many entries as the highest placeholder in the SQL, and they
  // MUST line up positionally with the placeholder index. A missing
  // or duplicated param would produce silent SQL injection holes or
  // wrong-row results at runtime.
  it("pg dialect — placeholder count equals params array length", () => {
    fc.assert(
      fc.property(selectArb, (sel) => {
        let compiled: { sql: string; params: readonly unknown[] }
        try {
          compiled = pgDialect().createPrinter().print(sel)
        } catch (err) {
          if (err instanceof SumakError) return
          throw err
        }
        const placeholderCount = (compiled.sql.match(/\$\d+/g) ?? []).length
        // PG uses `$1`-style; every `$N` corresponds to one params entry.
        // Note: the same param can appear multiple times in SQL (e.g.
        // `col = $1 OR other = $1`) — but currently sumak emits a fresh
        // index for each appearance, so count is a strict upper bound
        // and an exact-equal in practice.
        expect(placeholderCount).toBe(compiled.params.length)
      }),
      { numRuns: 200 },
    )
  })
})
