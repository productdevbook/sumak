import type { ExpressionNode, SelectNode } from "../../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../../src/ast/nodes.ts"

/**
 * Regression corpus — hand-curated AST shapes that once tripped the
 * printer in a way the fuzzer wouldn't reliably reach. Each entry is
 * a minimal reproducer with a short note on why it's here. The corpus
 * suite runs every shape through every dialect on every test run —
 * cheap, and it locks the fix in place forever.
 *
 * Adding to the corpus: when you find a crash (via fuzz or
 * production), reduce to the smallest shape that reproduces, add it
 * here with a comment explaining the bug + the commit that fixed it.
 */
export interface CorpusEntry {
  /** Short descriptive name — shows up in the test title. */
  readonly name: string
  /** Optional note: which commit fixed it / what the bug was. */
  readonly note?: string
  /** The AST shape that used to crash. */
  readonly node: SelectNode
}

function selectWhere(where: ExpressionNode): SelectNode {
  return {
    ...createSelectNode(),
    from: tableRef("users"),
    columns: [{ type: "star" }],
    where,
  }
}

export const corpus: readonly CorpusEntry[] = [
  {
    // Deeply nested AND that used to run the old recursive printer
    // out of stack on some JS engines. Now handled iteratively.
    name: "deep-AND-chain-64",
    node: (() => {
      let expr: ExpressionNode = {
        type: "binary_op",
        op: "=",
        left: { type: "column_ref", column: "id" },
        right: { type: "literal", value: 1 },
      }
      for (let i = 0; i < 64; i++) {
        expr = {
          type: "binary_op",
          op: "AND",
          left: expr,
          right: {
            type: "binary_op",
            op: "=",
            left: { type: "column_ref", column: "id" },
            right: { type: "literal", value: i },
          },
        }
      }
      return selectWhere(expr)
    })(),
  },
  {
    // NULL literal on both sides of equality — earlier printers
    // emitted `NULL = NULL` instead of rewriting to `IS NULL`.
    // The fix canonicalises null-comparison at normalize time.
    name: "null-literal-equality",
    node: selectWhere({
      type: "binary_op",
      op: "=",
      left: { type: "literal", value: null },
      right: { type: "literal", value: null },
    }),
  },
  {
    // IS NULL wrapped in NOT — printer once double-wrapped parens.
    name: "not-is-null",
    node: selectWhere({
      type: "unary_op",
      op: "NOT",
      operand: {
        type: "is_null",
        expr: { type: "column_ref", column: "email" },
        negated: false,
      },
      position: "prefix",
    }),
  },
  {
    // BETWEEN with literal bounds — the ordering of emitted SQL
    // tokens needs to be `expr BETWEEN low AND high`, and low/high
    // must keep their literal formatting.
    name: "between-literals",
    node: selectWhere({
      type: "between",
      expr: { type: "column_ref", column: "age" },
      low: { type: "literal", value: 18 },
      high: { type: "literal", value: 65 },
      negated: false,
    }),
  },
  {
    // String literal containing a single quote — earlier code did a
    // naive replace that let `')` escape the quoting on one path.
    // Verify round-trips cleanly now.
    name: "string-with-apostrophe",
    node: selectWhere({
      type: "binary_op",
      op: "=",
      left: { type: "column_ref", column: "name" },
      right: { type: "literal", value: "O'Reilly" },
    }),
  },
  {
    // Boolean literal on an expression — MSSQL doesn't have a native
    // boolean, so the printer rewrites to `1=1` / `1=0`. This shape
    // pins that behaviour.
    name: "boolean-literal-equality",
    node: selectWhere({
      type: "binary_op",
      op: "=",
      left: { type: "literal", value: true },
      right: { type: "literal", value: true },
    }),
  },
]
