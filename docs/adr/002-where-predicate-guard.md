# ADR 002: Predicate guard + three-arg `where()` overload

**Status:** Accepted · 2026-05-18 / 2026-05-19

## Context

Pre-v0.0.15, `TypedSelectBuilder.where` accepted only an `Expression<boolean>` or a callback returning one:

```ts
where(exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>)
```

At runtime, TypeScript types are erased. A kysely-style call like `.where("id", "=", 1)` passes three arguments; JavaScript's loose call site silently drops the second and third, leaving `where("id")`. The implementation then called `unwrap("id")` — which returned `("id").node` → `undefined` — and stored `undefined` as the predicate. The printer omitted the WHERE clause entirely:

```ts
db.deleteFrom("users").where("id", "=", 1).toSQL()
// Pre-fix:  { sql: 'DELETE FROM "users"', params: [] }
//           ↑ a typo'd row-scoped DELETE silently turns into a table wipe.
// Post-fix: TypeError (PR #95), then valid SQL via the new overload (PR #99)
```

The bug was hidden for ~7 months because:

1. The TypeScript typecheck rejected `.where("id", "=", 1)` at the boundary, so no test reached the silent path.
2. The bench scenarios — which DID call `.where("id", "=", 1)` at runtime in `bench/src/scenarios.ts` — were comparing sumak's `SELECT * FROM users` against the competitors' parameterized `SELECT … WHERE id = $1` and reporting the (unfair) advantage as a win.

## Decision

Two complementary changes shipped in v0.0.15:

1. **Runtime predicate guard** (PR #95) — `unwrapPredicate(value, method)` in `src/ast/typed-expression.ts` rejects anything that isn't an Expression-shaped object with a `TypeError` pointing at the callback form. Used by every typed builder's `where` / `orWhere` / `having`.

2. **Type-safe three-arg overload** (PR #99) — `TypedSelectBuilder.where` (and friends) accept the kysely-style three-arg form natively, with per-operator RHS narrowing via `WhereValueForOp<Op, ColType>`:

   ```ts
   where("name", "like", 42) // ❌ type-error: number not assignable to string
   where("deleted_at", "is", 0) // ❌ type-error: only `null` valid for `is`
   where("id", "in", 1) // ❌ type-error: array required
   ```

   Operators: `=`, `==`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `like`, `not like`, `ilike`, `not ilike`, `in`, `not in`, `is`, `is not`.

## Why this combination

The guard alone would have closed the safety hole but left every kysely user hitting a TypeError on their first `.where("col", "=", val)` call — an unhappy onboarding moment for a real user expectation. The overload alone would have worked but left no protection for the partial-call cases (`.where("id")` with one arg, `.where(undefined)`, `.where(42)`). Both together: the natural shape works; everything else fails loudly.

The discriminator between the two paths is a small runtime check inside the implementation signature:

```ts
where(arg0, op?, val?) {
  if (isWhere3ArgCall([arg0, op, val])) { /* three-arg path */ }
  if (typeof arg0 === "function") { /* callback path */ }
  return ... unwrapPredicate(arg0, ".where()")  // throws on primitives
}
```

`isWhere3ArgCall` requires `args.length === 3`, `arg0` and `op` both strings, AND `val !== undefined` UNLESS the op is `"is"` / `"is not"` (which legitimately accept `null` RHS, expressed as a JS `null` not `undefined`).

## Test coverage

- `test/builder/where-guard.test.ts` (PR #95, expanded in PR #105) — 17 tests pinning the partial-call paths still throw with diagnostic messages.
- `test/builder/where-3-arg.test.ts` (PR #99) — 28 tests covering every operator + RHS type combination + AST-equivalence with the callback form.
- The bench `bench/src/scenarios.ts` was rewritten to use the callback form (the original silent-bug victims), and a snapshot smoke test `bench/_scenarios.test.ts` now asserts equivalent SQL across sumak / drizzle / kysely so the same silent-divergence can't recur.

## Backlog flagged by this work

- **B2 — callback-returns-undefined diagnostic** (PR #105) — when a callback's `(c) => { c.id.eq(1) }` lacks the explicit `return`, the new error message names that specific footgun rather than the generic "Got undefined". Logged here because the original guard PR caught it generically; the diagnostic refinement is documented as a follow-up.
- **A2 — flat n-ary `logical_op` AST node** — every AND/OR chain still stores as a binary tree. Closing the remaining 1.3–1.5× sumak/kysely gap on `select-where-and` / `select-where-deep-and` likely needs the flat shape so the visitor/printer walk is O(1) per chain instead of O(N). Invasive (every walker/visitor/transformer site updates) — deferred past v0.0.15.

## What we won't reconsider

The default behaviour for an unrecognised RHS shape is **throw**, never silently drop. The pre-v0.0.15 silent path turned typo'd DELETE statements into table wipes. A loud failure is non-negotiable; any future expansion of accepted shapes (e.g. a `sql\`\``-template path) is opt-in by either type or explicit argument, not by inferring intent from a primitive.
