# SQL:2023 coverage notes

Brief audit of where sumak sits vs the SQL:2023 standard. **Not a TODO list** — most of these gaps will never be closed (vendor-specific divergence is the real world). The point is to be honest about what we do and don't compile, so users coming from a standards-first POV know what to expect.

## MERGE (`src/builder/merge.ts`)

Sumak supports the SQL:2016 core MERGE shape:

- `INTO target` / `USING source` / `ON predicate`
- `WHEN MATCHED THEN UPDATE SET …` / `WHEN MATCHED THEN DELETE`
- `WHEN NOT MATCHED THEN INSERT …`
- **`WHEN NOT MATCHED BY SOURCE THEN UPDATE SET …` / `THEN DELETE`** — fires for target rows that have no matching source row (the inverse of `WHEN NOT MATCHED [BY TARGET]`). Useful for full-sync MERGE patterns where the source is the new desired state. Builder methods: `.whenNotMatchedBySourceThenUpdate(set, cond?)` and `.whenNotMatchedBySourceThenDelete(cond?)`. AST: third variant `MergeWhenNotMatchedBySource` alongside `MergeWhenMatched` / `MergeWhenNotMatched`. Emitted on PG (17+) and MSSQL; MySQL and SQLite have no `MERGE` at all and throw at print time. ✅
- Per-branch `AND condition` ("WHEN MATCHED AND <cond>")
- CTE-prefixed MERGE (`.with(...)`)
- **`RETURNING` on MERGE** — `.returning(...cols)` / `.returning({ alias: expr })` / `.returningAll()` on the typed MERGE builder. PG 17+ accepts the standard form, including the PG-only `merge_action()` projection (top-level `mergeAction()` helper) which returns `'INSERT' | 'UPDATE' | 'DELETE'` per row. MSSQL has its own `OUTPUT` clause with different positioning and pseudo-tables; until that's wired up the printer throws `UnsupportedDialectFeatureError` (`MERGE_RETURNING` flag is PG-only). MySQL/SQLite have no `MERGE`. ✅

**SQL:2023 additions we don't have:**

- **`OVERRIDING { SYSTEM | USER } VALUE`** in `INSERT` actions — controls identity-column overrides on the insert branch. Currently you'd need raw SQL.
- **MSSQL `OUTPUT` clause on MERGE** — the SQL Server analogue to `RETURNING`. Reuses the `MergeNode.returning` slot? Likely a separate surface because the syntax differs (`OUTPUT $action, inserted.id, deleted.id`) and the column-scope pseudo-tables (`inserted` / `deleted`) have no PG counterpart.

## Window functions

Sumak's printer allowlist (`src/printer/base.ts`) covers: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST`, `NTILE`, `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`.

The `WindowBuilder` exposes:

- `partitionBy(...)`, `orderBy(...)`, `rows()` / `range()` / `groups()` frames.
- Frame bounds: `unbounded_preceding`, `preceding N`, `current_row`, `following N`, `unbounded_following`.

**Supported SQL:2003+ extensions:**

- **Named `WINDOW` clause** — `SELECT … WINDOW w AS (PARTITION BY x), w2 AS (w ORDER BY y)`. Register a window once via `.window(name, build)` on the SELECT builder, then reference it from multiple `over(fn, name)` calls. Includes window inheritance (`.window("w2", b => b.orderBy("y"), { from: "w" })`). AST: `SelectNode.windows: NamedWindow[]` + `WindowFunctionNode.windowName?: string`. The printer emits `WINDOW name AS (...)` between HAVING and ORDER BY on PG / MySQL / SQLite; MSSQL throws `UnsupportedDialectFeatureError` because SQL Server has no `WINDOW` clause. ✅

**SQL:2023 additions we don't have:**

- **`EXCLUDE { CURRENT ROW | GROUP | TIES | NO OTHERS }`** frame-exclude clause. The `FrameSpec` type has no `exclude` field.
- **`PERCENTILE_CONT` / `PERCENTILE_DISC`** (inverse-distribution aggregates with `WITHIN GROUP`) — top-level `percentileCont()` / `percentileDisc()` builders plus the generic `withinGroup(agg, [...orderBy])` attach the SQL standard ordered-set clause: `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_ms)`. Emitted on PG, MySQL 8, MSSQL. SQLite has no equivalent (`assertFeature("sqlite", "ORDERED_SET_AGGREGATES")` throws). ✅

## JSON / SQL:2016 + 2023

Sumak's JSON surface (`src/builder/eb.ts`):

- `jsonAgg`, `toJson`, `jsonBuildObject` (PG-only).
- `jsonRef` for PG path-extraction operators (`->`, `->>`, `#>`, `#>>`).
- `isJson` — `expr IS [NOT] JSON [VALUE|SCALAR|ARRAY|OBJECT]` predicate.
- `jsonValue` — `JSON_VALUE(expr, '$.path' [RETURNING type])`.
- `jsonQuery` — `JSON_QUERY(expr, '$.path' [RETURNING type])`.
- `jsonExists` — `JSON_EXISTS(expr, '$.path')` boolean predicate.

**Supported SQL:2023 standard JSON functions:**

- **`JSON_VALUE(expr, path [RETURNING type])`** — top-level `jsonValue(jsonExpr, path, { returning? })`. The path arg is emitted as an inline string literal (SQL standard), and the optional `RETURNING <type>` runs through the same `validateDataType` guard as `cast()` before injection. Dialect matrix: PG 17+, MySQL 8, MSSQL accept the bare form; PG 17+ and MySQL 8 also accept `RETURNING type`. MSSQL's `JSON_VALUE` always returns nvarchar(4000) — the printer refuses a non-empty `returningType` and points at the CAST workaround. SQLite has no equivalent (`json_extract` differs on path grammar and missing-vs-null semantics) and the printer refuses via the `JSON_VALUE_FN` feature flag. AST: a new `FunctionCallNode.returningType?: string` slot (no new node type) so the same shape opens the door for `JSON_QUERY` later. The verbose `NULL ON ERROR` / `DEFAULT 'x' ON ERROR` empty/error handlers are not surfaced yet; write the raw clause via `unsafeRawExpr` if needed. ✅
- **`JSON_QUERY(expr, path [RETURNING type])`** — top-level `jsonQuery(jsonExpr, path, { returning? })`. Sibling of `JSON_VALUE` that returns JSON-typed values (objects, arrays, scalars-as-JSON) rather than coerced scalars. Reuses the same `FunctionCallNode.returningType` slot as `JSON_VALUE`, so the `validateDataType` guard applies. Dialect matrix: PG 17+ accepts bare + `RETURNING`; MSSQL accepts only the bare form (its `JSON_QUERY` always returns nvarchar — the printer refuses `returningType` via the same path used for `JSON_VALUE`). MySQL 8 has no `JSON_QUERY` (use `JSON_EXTRACT`) and SQLite has nothing equivalent — both throw `UnsupportedDialectFeatureError` via the `JSON_QUERY_FN` flag. The verbose `WRAPPER` / `KEEP QUOTES` / empty-error handlers are not surfaced; use `unsafeRawExpr` if needed. ✅
- **`JSON_EXISTS(expr, path)`** — top-level `jsonExists(jsonExpr, path)`. Boolean predicate that returns TRUE when the path resolves in the JSON document; closer to PG's existence operator than to JSON extraction. PG 17+ and MSSQL accept the standard form. MySQL has `JSON_CONTAINS_PATH(json, 'one'|'all', '$.path', …)` with a different argument shape (no native `JSON_EXISTS`); SQLite has nothing equivalent — both throw via the `JSON_EXISTS_FN` flag. ✅

**SQL:2023 standard JSON functions we don't have:**

- **`JSON_TABLE(expr, path COLUMNS (…))`** — pivot JSON array into a relation (table-valued function). PG 17 added it; MySQL 8 has had it; MSSQL `OPENJSON` is the closest.

The remaining gaps are all standardized but uniformly opt-in across DB engines — adding builder helpers makes most sense once at least PG and MySQL share the same shape. Today the safest user-land path is `unsafeRawExpr("JSON_QUERY(...)", [...])`.

## Other 2023-flavor features

- **`UNIQUE NULLS NOT DISTINCT`** in unique constraints — PG 15+. Sumak supports it on column-level (`text().unique({ nullsNotDistinct: true })`) and table-level (`{ uniques: [{ columns, nullsNotDistinct: true }] }`) constraints. The diff engine threads the flag onto `ColumnDefinitionNode.uniqueNullsNotDistinct` / `UniqueConstraintNode.nullsNotDistinct`; the DDL printer emits `UNIQUE NULLS NOT DISTINCT` on PG and throws `UnsupportedDialectFeatureError` on MySQL/SQLite/MSSQL. ✅
- **`ANY_VALUE(expr)`** aggregate — accepted on PG 16+; not in the allowlist (would just need adding to `KNOWN_FUNCTIONS`).
- **`STRING_AGG` ordering inside the aggregate** — sumak has this via `aggOrderBy`, but the SQL:2023 syntax is `STRING_AGG(expr, sep ORDER BY …)` which our printer already emits correctly. ✅
- **`GROUPING SETS` / `CUBE` / `ROLLUP`** — pre-2023 but recently added on the sumak side; present in `groupBy`. ✅

## Summary

Sumak's coverage is roughly "core SQL:2016 + vendor-portable parts of SQL:2023". `JSON_TABLE` and frame-`EXCLUDE` are the two most-likely-to-be-requested remaining gaps; everything else is either niche or trivially reachable via `unsafeRawExpr`. If you find a gap that affects your use case, open an issue with the exact statement you want to compile and the dialect — that pins down the AST change needed.
