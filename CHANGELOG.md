# Changelog

## [Unreleased]

### Breaking Changes

- **Col<T> — 22 deprecated methods removed.** All have 1:1 replacements:
  - `.eqCol(c)` / `.neqCol` / `.gtCol` / `.gteCol` / `.ltCol` / `.lteCol` → `.eq(c)` / `.neq` / `.gt` / `.gte` / `.lt` / `.lte` (the base methods already accept `T | Col<T> | Expression<T>`).
  - `.eqExpr(e)` / `.neqExpr` / `.gtExpr` / `.gteExpr` / `.ltExpr` / `.lteExpr` → same — pass the Expression to the base method.
  - `.notLike(p)` → `.like(p, { negate: true })`.
  - `.ilike(p)` → `.like(p, { insensitive: true })`.
  - `.notIlike(p)` → `.like(p, { negate: true, insensitive: true })`.
  - `.notBetween(lo, hi)` → `.between(lo, hi, { negate: true })`.
  - `.betweenSymmetric(lo, hi)` → `.between(lo, hi, { symmetric: true })`.
  - `.notIn(values)` → `.in(values, { negate: true })`.
  - `.inSubquery(q)` → `.in(q)`.
  - `.notInSubquery(q)` → `.in(q, { negate: true })`.
  - `.isNotNull()` → `.isNull({ negate: true })`.
  - `.isDistinctFrom(v)` → `.distinctFrom(v)`.
  - `.isNotDistinctFrom(v)` → `.distinctFrom(v, { negate: true })`.

- **Typed builders — 4 deprecated methods removed:**
  - `TypedSelectBuilder.selectExpr(expr, "alias")` → `.select({ alias: expr })`.
  - `TypedSelectBuilder.selectExprs(dict)` → `.select(dict)`.
  - `TypedUpdateBuilder.setExpr("col", expr)` → `.set({ col: expr })`.
  - `TypedInsertBuilder.returningExpr(expr, "alias")` → `.returning({ alias: expr })`.

- **`.explain()` now returns a chainable `ExplainBuilder`** instead of a bare `{ build, compile }` object. Call `.toSQL()` / `.compile(printer)` / `.build()` on the returned builder.

- **Row-locking methods unified into `.lock({ ... })`.** Six methods removed:
  - `.forUpdate()` → `.lock({ mode: "update" })`.
  - `.forShare()` → `.lock({ mode: "share" })`.
  - `.forNoKeyUpdate()` → `.lock({ mode: "no_key_update" })`.
  - `.forKeyShare()` → `.lock({ mode: "key_share" })`.
  - `.forUpdate().skipLocked()` → `.lock({ mode: "update", skipLocked: true })`.
  - `.forUpdate().noWait()` → `.lock({ mode: "update", noWait: true })`.
  - `skipLocked` and `noWait` cannot be set simultaneously — throws at runtime.

- **`onConflict*` methods unified into `.onConflict({ ... })`.** Five methods removed:
  - `.onConflictDoNothing(...cols)` → `.onConflict({ columns: [...], do: "nothing" })`.
  - `.onConflictDoUpdate(cols, set)` → `.onConflict({ columns, do: { update: set } })`.
  - `.onConflictDoUpdateSet(cols, values)` → `.onConflict({ columns, do: { update: values } })` (same object shape).
  - `.onConflictConstraintDoNothing(name)` → `.onConflict({ constraint: name, do: "nothing" })`.
  - `.onConflictConstraintDoUpdate(name, set)` → `.onConflict({ constraint: name, do: { update: set } })`.

- **`.with(name, query, recursive = false)` is now `.with(name, query, options?)`** with `{ recursive?: boolean }`.
  ```ts
  // Before: .with("tree", query, true)
  // After:  .with("tree", query, { recursive: true })
  ```

### Rationale

Each removed method had a deprecation-period covering PRs #42–#45 and was kept as a
`@deprecated` shim. The new unified forms (`.eq(T | Col | Expression)`, opt-arg variants
like `.like(pat, { negate, insensitive })`, and object-form dict selectors) replace the
26 specialized methods with a smaller, more orthogonal API. `Col<T>` went from 35 methods
to 15. The net effect is a smaller public surface and one canonical way to express each
query pattern.
