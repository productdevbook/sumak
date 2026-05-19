# ADR 004 — Flat n-ary `logical_op` AST node (deferred)

**Status**: Proposed / Deferred.
**Backlog ID**: A2.
**Date**: 2026-05-19.

## Context

`AND` and `OR` chains compile to a **left-leaning binary tree** of `binary_op` AST nodes:

```
{ type: "binary_op", op: "AND",
  left: { type: "binary_op", op: "AND",
    left: { type: "binary_op", op: "AND",
      left: a, right: b },
    right: c },
  right: d }
```

i.e. `(((a AND b) AND c) AND d)`. Five clauses → four `binary_op` allocations + three levels of recursion at every traversal site.

The bench scenario `select-where-deep-and` (5-clause AND on `posts`) consistently runs ~1.35× kysely after the iterative-chain-walk optimization in PR #113. Kysely's compiler internally represents the same clause as a flat list of operands, so it pays the visitor dispatch cost once instead of N times.

## Decision (for now)

**Do not change the AST yet.** The current shape — binary `BinaryOpNode` with `{ op: "AND"|"OR", left, right }` — stays.

## Why deferred

This is the most invasive AST change available. Touching:

| Surface                               | File(s)                          | What changes                                              |
| ------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| AST type union                        | `src/ast/nodes.ts`               | new `LogicalOpNode` variant                               |
| Walker                                | `src/ast/walker.ts`              | new case in expression visitor                            |
| Visitor                               | `src/ast/visitor.ts`             | new visit method                                          |
| Transformer                           | `src/ast/transformer.ts`         | new transform branch                                      |
| Builder                               | `src/builder/eb.ts` (`and`/`or`) | emit `LogicalOpNode` instead of nested `binary_op`        |
| Normalize                             | `src/normalize/expression.ts`    | flatten + identity-preserve over operands                 |
| Optimize                              | `src/optimize/rules.ts`          | rewrite rules that pattern-match AND/OR                   |
| Printer                               | `src/printer/base.ts`            | drop the iterative spine walk; render `ops.join(" AND ")` |
| Every `assertNever(node)` switch site | scattered                        | add the new case                                          |
| Snapshot suite (~200 files)           | `test/__snapshots__/`            | may move if param ordering shifts                         |

The fanout is roughly 20-30 files. Done right, it produces:

- ~5–15% compile-time win on deep-AND/OR chains (estimate based on visitor dispatch saved).
- Cleaner normalize/optimize code (operate on a flat operand list, not a tree).
- Simpler `flattenLogical` helper (becomes a no-op trivially).

Done wrong, it introduces:

- Snapshot churn — if anything reorders operands.
- Param-index bugs — same hazard as the iterative chain walk in PR #113 (descent vs print order).
- Plugin breakage — any third-party `Transformer` that pattern-matches `binary_op` for AND/OR misses the new shape.

The risk profile is poor for **autonomous** application. A human reviewer with snapshot diff tooling is the right driver.

## Proposed implementation sketch (for the human picking this up)

### 1. AST

```ts
export interface LogicalOpNode {
  type: "logical_op"
  op: "AND" | "OR"
  operands: ReadonlyArray<ExpressionNode> // ≥ 2 operands; builder enforces
}
```

Add to `ExpressionNode` union; mark `BinaryOpNode` AND/OR as deprecated (still accepted on input for a transition window).

### 2. Builder

`and(a, b, c, d)` directly emits `{ type: "logical_op", op: "AND", operands: [a, b, c, d] }`.
`or(...)` mirrors. The existing `flattenLogical` helper becomes a flat-construction helper instead of a tree-rebalancer.

### 3. Normalize

In `normalize/expression.ts`, add a sub-pass that converts any incoming `binary_op` AND/OR chain into `logical_op`. Run it before the existing identity-preserving recurse so downstream sub-passes see the flat shape.

Keep the recurse identity-preserving across the new node:

```ts
case "logical_op": {
  const operands = expr.operands.map(transform)
  const same = operands.every((o, i) => o === expr.operands[i])
  return same ? expr : { ...expr, operands }
}
```

### 4. Printer

```ts
case "logical_op": {
  const parts = node.operands.map((o) => this.printExpression(o))
  return `(${parts.join(` ${node.op} `)})`
}
```

Single `.map` + `.join`. No spine descent.

**Param-order test pin**: the existing `bench/__snapshots__/_scenarios.test.ts.snap` is the canary — if any `$N` index shifts after the change, the snapshot fails.

### 5. Compatibility

Plugins / external transformers that look for `binary_op` AND/OR will silently miss `logical_op`. Two options:

- Pin compat: keep the builder emitting `binary_op` and only flatten at normalize time. Lowest plugin breakage, leaves the perf gain on the table for callers who skip normalize.
- Hard cutover: emit `logical_op` everywhere; document the migration in `AGENTS.md`. Faster end-state, but third-party `Transformer` subclasses need to be updated.

Recommend option 1 for the first release, option 2 once 1.0 is on the table.

## Alternatives considered

- **Extend `BinaryOpNode` with an optional `operands?: ExpressionNode[]` field.** Rejected — every existing consumer expects `left` and `right` to be defined, and an "optional alternative shape" is worse than a separate type.
- **Do nothing.** Status quo. The 1.35× gap on deep-AND is real but bounded; PR #113 already closed most of it.

## Reversal trigger

Pick this up when **either** of:

- A specific user benchmark shows deep-AND chains are a hot path in production.
- A separate refactor (e.g. CNF rewriting for optimizer) wants the flat shape anyway.
