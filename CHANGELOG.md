# Changelog

## [Unreleased]

### Bug fixes (correctness)

- **`Col.eq(null)` / `.neq(null)` auto-lower to `IS NULL` / `IS NOT NULL`.**
  `col = NULL` is always UNKNOWN in SQL three-valued logic and never matches.
  Also covers the `val(null)` / `Expression<null>` forms.
- **`IN ([])` / `NOT IN ([])` constant-fold to `FALSE` / `TRUE`.** The previous
  output was `col IN ()` — a syntax error on every dialect. MSSQL uses the
  portable `(1=0)` / `(1=1)` form since bare `TRUE`/`FALSE` are rejected in
  predicates there.
- **`UPDATE … SET … FROM … JOIN …` emits in the correct order.** PostgreSQL
  requires `FROM` before any JOINs; the base printer now emits it that way,
  and the MSSQL override was fixed in lockstep. MySQL's `UPDATE t JOIN t2 …`
  multi-table form got a dedicated `printUpdate` override that throws a
  helpful error if `.from()` is used (MySQL has no UPDATE…FROM).
- **JSON `#>` / `#>>` path operators emit PG text-array literal.**
  `atPath("a.b.c")` was emitting `#>'a.b.c'`; now emits `#>'{a,b,c}'`. Path
  segments are validated — quote, comma, brace, backslash, and newline
  characters are rejected to prevent injection through attacker-controlled
  paths.
- **`selectFromSubquery(...).toSQL()` works.** The entry point was building a
  `TypedSelectBuilder` without a printer/compile callback, so the chain
  threw at runtime. Now wires the dialect's printer through.
- **DDL `CREATE TABLE … AS SELECT` / `CREATE VIEW AS` render the embedded
  SELECT.** Previously emitted a `(SELECT ...)` placeholder string — silent
  data corruption. `DDLPrinter` now accepts a `SelectPrinter` callback from
  the dialect and merges the SELECT's params into the DDL output.
- **Subquery flattening preserves the outer alias.**
  `SELECT * FROM (SELECT * FROM users) AS u` now flattens to
  `FROM users AS u`, not `FROM users` (previously the `u` binding was lost,
  breaking any `u.col` references).
- **`valuesMany([])` / `.values({})` / `.whenMatchedThenUpdate({})` throw.**
  Empty inputs previously produced invalid SQL with no error. Messages
  suggest `.defaultValues()` when that was the intent.
- **`InsertBuilder.defaultValues()` clears `columns` / `values` / `source`.**
  Calling `.values(row).defaultValues()` used to silently drop the row and
  emit `DEFAULT VALUES`. Now there's one authoritative INSERT shape.

### Plugins

- **MERGE node support — closes #57.** `SoftDeletePlugin`,
  `MultiTenantPlugin`, and `AuditTimestampPlugin` now handle `MergeNode`,
  not just the DML quartet. Previously `db.mergeInto(...)` silently bypassed
  every plugin — a security bug for multi-tenant schemas.
  - **Multi-tenant (security critical):** qualifies `ON` with
    `target.tenant_id = ?`, adds a `source.tenant_id = ?` guard when the
    source is also tenant-aware, and injects `tenant_id` into every
    `WHEN NOT MATCHED INSERT` column list + values tuple.
  - **Soft-delete:** qualifies `ON` with `target.deleted_at IS NULL` (or
    `target.deleted = FALSE` on the boolean flag) so deleted rows never
    match and fall through to `WHEN NOT MATCHED`.
  - **Audit-timestamp:** appends `updated_at = NOW()` to `WHEN MATCHED
UPDATE` sets; appends `created_at` + `updated_at` columns/values to
    `WHEN NOT MATCHED INSERT`. Deduplicates when caller already set them.
- **Plugins are idempotent on MERGE.** `MergeNode.flags` (new) carries
  `QueryFlags.SoftDeleteApplied` / `MultiTenantApplied` so a double-
  registered plugin or a cached-AST re-compile won't duplicate guards.
- **Hook context no longer mutated in place.** `Hookable.callHook` clones
  the ctx object per iteration so plugins that retain a reference don't
  see it rewritten mid-chain.

### Builder surface polish

- **`.with(name, query, options?)` accepts a builder directly.** Every DML
  builder's `.with()` now takes `SelectNode | { build(): SelectNode }` —
  no more manual `.build()` at the call site.
- **`.toCompiled<P>()` on every typed builder.** Select / Insert / Update /
  Delete all expose a chainable method that pre-bakes SQL with placeholder
  slots; previously callers had to drop to `compileQuery(...)`.
- **`CmpArg<T>` accepts `PlaceholderMarker`.** `id.eq(placeholder("x"))` is
  type-safe now (previously needed `as unknown as T` cast).
- **`mergeInto(target, { source, alias, on })` — options-object only.** The
  legacy 4-positional-arg form is gone.
- **`.lock({ ... })` accepts `of: string[]`** (PG `FOR UPDATE OF t1, t2`).
- **`op` namespace for arithmetic.** `op.add / sub / mul / div / mod / neg`
  replace the flat `add/sub/...` exports.
- **Escape hatches `unsafeRawExpr` / `unsafeSqlFn` are flat-exported.** Plus
  `countDistinct`, `sumDistinct`, `avgDistinct`, `aggOrderBy`,
  `subqueryExpr`, `tuple`, `toJson` moved out of hidden export territory.
- **`SchemaBuilder`, `CaseBuilder` types exported.** Users can annotate
  these intermediates without reaching into `src/`.
- **`TypedMergeBuilder.toSQL()`** exists now.
- **`TypedDeleteBuilder.explain()` returns `ExplainBuilder`** like every
  other builder.
- **Per-dialect entry points (`sumak/pg`, `sumak/mysql`, etc.) stopped
  re-exporting the concrete `PgPrinter` / etc. classes.** Hold the
  `Printer` interface via `db.printer()` — the concrete class was never
  intended as public surface.
- **`FOR UPDATE` semantics documented per dialect** (PG / MySQL / SQLite /
  MSSQL support matrix in the README).

### Internal

- **`SoftDeletePlugin._config` replaced with `getConfig()`.** `#`-private
  fields back the method; the plugin's shape no longer exposes internal
  state just because JSDoc said `@internal`.
- **Typed builder constructors take `(printer?, compile?)` directly.**
  No more `(b as any)._printer = ...` post-construction mutation on
  Insert/Update/Delete/Merge.
- **`TypedMergeBuilder._with()` uses a constructor escape-hatch**
  (`existingBuilder?: MergeBuilder`) instead of `as any` reassignment.
- **`collectTableRefs` in the optimizer recurses into 8 more AST node
  types** (CASE, json_access, aliased_expr, full_text_search, tuple,
  array_expr, window_function, function_call.filter), so
  `predicatePushdown` no longer silently skips pushable predicates.
  `subquery` / `exists` remain opaque on purpose (scope isolation).

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

### Experimental

- **SQL:2023 Part 16 (SQL/PGQ) spike** — `db.graphTable(name).match\`...\`.columns({...}).as(...)`+`db.selectFromGraph(g)`. Emits standard `FROM GRAPH_TABLE(graph MATCH ... COLUMNS (...))` today on all dialects. Apache AGE routing (`FROM cypher(...)`), multi-pattern joins, quantified patterns, and path variables are deferred to follow-up PRs. Design doc: `/tmp/pgq-spike.md`. See `GraphTableBuilder`, `GraphTableNode`, `GraphPatternNode`, `GraphColumnNode`. Marked `@experimental` — the surface may change.

### Rationale

Each removed method had a deprecation-period covering PRs #42–#45 and was kept as a
`@deprecated` shim. The new unified forms (`.eq(T | Col | Expression)`, opt-arg variants
like `.like(pat, { negate, insensitive })`, and object-form dict selectors) replace the
26 specialized methods with a smaller, more orthogonal API. `Col<T>` went from 35 methods
to 15. The net effect is a smaller public surface and one canonical way to express each
query pattern.
