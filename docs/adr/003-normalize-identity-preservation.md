# ADR 003: Identity-preserving `recurse` for normalize fixed-point convergence

**Status:** Accepted · 2026-05-19

## Context

`normalizeExpression` in `src/normalize/expression.ts` runs five sub-passes:

1. `simplifyNegation` — `NOT NOT x → x`, `NOT TRUE → FALSE`, `NOT (x IS NULL) → x IS NOT NULL`.
2. `foldConstants` — folds `1 + 2 → 3`, canonicalizes `literal = col → col = literal`.
3. `simplifyTautologies` — `x AND TRUE → x`, `x OR FALSE → x`, etc.
4. `flattenLogical` — collapses nested AND/OR back to a left-leaning canonical chain.
5. `deduplicatePredicates` — removes structurally-equal AND clauses.

Each sub-pass falls back to a generic `recurse(expr, transform)` helper for nodes it doesn't directly handle. A single sweep of all five doesn't reach a fixed point for every input — e.g. `(NOT (false OR true)) = (param = (col = 0))`:

- Pass 1, `simplifyTautologies` folds `false OR true → true`, giving `(NOT true) = (param = (col = 0))`.
- Pass 2 of `normalizeExpression` (if there was one) would fold `NOT true → false`, then `foldConstants` flips the literal to the RHS.

The property fuzzer in `test/fuzz/properties.test.ts` (PR #101) caught this within 81 random ASTs. The first naive fix (PR #102) wrapped the sub-pass sequence in a `for (i < 6; ++i)` loop with a `result === previous` exit condition. The exit condition NEVER fired — `recurse` unconditionally rebuilt the parent node:

```ts
case "binary_op":
  return { ...expr, left: transform(expr.left), right: transform(expr.right) }
```

even when both children came back unchanged. The fixpoint loop ran six full sweeps every call. The bench regressed catastrophically:

| scenario                | pre-#102     | with broken fixpoint loop |
| ----------------------- | ------------ | ------------------------- |
| `select-where-and`      | kysely 1.66× | kysely 5.17×              |
| `select-where-deep-and` | kysely 1.71× | kysely 5.82×              |
| `select-where-eq`       | kysely 1.14× | kysely 1.62×              |

PR #103 reverted PR #102.

## Decision

**Make `recurse` and every sub-pass preserve `===` identity on no-op cases.** Each branch checks whether any child rewrote and returns the original node verbatim when none did:

```ts
case "binary_op": {
  const left = transform(expr.left)
  const right = transform(expr.right)
  return left === expr.left && right === expr.right ? expr : { ...expr, left, right }
}
```

Same pattern in every other case + every sub-pass's "matched but no-op" branch (e.g. `simplifyNegation` for a `NOT x` where `x` doesn't get rewritten).

With identity preservation in place, restore the fixpoint loop with the `result === previous` exit — already-normalized inputs exit after one body iteration; the worst fuzzer counterexample settles in two; an iteration cap (6) guards against pathological rewrites that oscillate.

Shipped in PR #104.

## Bench impact

Identity preservation makes the sub-passes themselves cheaper too — they no longer allocate new objects for the common no-change case. Result: bench numbers BETTER than the pre-#102 baseline on several scenarios:

| scenario                | pre-#102     | post-#104                 |
| ----------------------- | ------------ | ------------------------- |
| `select-where-eq`       | kysely 1.14× | **sumak 1.08×** (flipped) |
| `select-where-and`      | kysely 1.66× | kysely 1.32×              |
| `update-where`          | kysely 1.30× | kysely 1.15×              |
| `delete-where`          | kysely 1.39× | kysely 1.26×              |
| `select-where-deep-and` | kysely 1.71× | kysely 1.35×              |

## Property tightening

The fuzz property in `test/fuzz/properties.test.ts` is now strict single-call idempotence:

```ts
expect(normalizeExpression(normalizeExpression(x))).toEqual(normalizeExpression(x))
expect(optimize(optimize(q))).toEqual(optimize(q))
```

700 random inputs (300 expression + 200 query + 200 optimize) all pass. If a future refactor regresses to identity-non-preserving `recurse`, the property fuzzer will catch it the moment a counterexample is generated.

## Why a cap on the loop, not `while (changed)`

A future rewrite-rule bug that oscillates between two AST shapes would cause an infinite loop in user-facing `compile()`. With a cap of 6, the worst case is two extra wasted sweeps before falling out of the loop — a perf bug, not a hang. The fuzzer has never produced a shape that needed more than 2 sweeps, so the cap is well-padded.

## What this enables

The identity-preservation pattern unlocks two future improvements (deferred past v0.0.15):

1. **Caching the normalized AST** in cases where the user reuses a built `SelectNode`. With `===` preserved, a `WeakMap<Node, NormalizedNode>` becomes safe.
2. **Differential bench** — measuring the cost of `normalize(unchanged_input)` directly to track future regressions.

Neither was implemented in this round; flagging in the loop-state backlog.
