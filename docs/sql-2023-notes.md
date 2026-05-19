# SQL:2023 coverage notes

Brief audit of where sumak sits vs the SQL:2023 standard. **Not a TODO list** — most of these gaps will never be closed (vendor-specific divergence is the real world). The point is to be honest about what we do and don't compile, so users coming from a standards-first POV know what to expect.

## MERGE (`src/builder/merge.ts`)

Sumak supports the SQL:2016 core MERGE shape:

- `INTO target` / `USING source` / `ON predicate`
- `WHEN MATCHED THEN UPDATE SET …` / `WHEN MATCHED THEN DELETE`
- `WHEN NOT MATCHED THEN INSERT …`
- Per-branch `AND condition` ("WHEN MATCHED AND <cond>")
- CTE-prefixed MERGE (`.with(...)`)

**SQL:2023 additions we don't have:**

- **`WHEN NOT MATCHED BY SOURCE`** — fires for target rows that have no matching source row (the inverse of `WHEN NOT MATCHED [BY TARGET]`). PostgreSQL added it in 17; MSSQL has had it forever; MySQL doesn't have MERGE at all. Sumak's `MergeWhenMatched` / `MergeWhenNotMatched` types would need a third variant.
- **`OVERRIDING { SYSTEM | USER } VALUE`** in `INSERT` actions — controls identity-column overrides on the insert branch. Currently you'd need raw SQL.
- **`RETURNING` on MERGE** — PG 17+ supports it, the AST has no slot for it on MergeNode.

## Window functions

Sumak's printer allowlist (`src/printer/base.ts`) covers: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST`, `NTILE`, `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`.

The `WindowBuilder` exposes:

- `partitionBy(...)`, `orderBy(...)`, `rows()` / `range()` / `groups()` frames.
- Frame bounds: `unbounded_preceding`, `preceding N`, `current_row`, `following N`, `unbounded_following`.

**SQL:2023 additions we don't have:**

- **Named `WINDOW` clause** — `SELECT … WINDOW w AS (PARTITION BY x), w2 AS (w ORDER BY y)`. Lets you reuse window definitions across multiple window-function calls without copy-paste. Currently each `over(…)` carries its own window spec. AST would need a `windows: NamedWindow[]` slot on `SelectNode` plus a `WindowRef` node that lookup-resolves at print time.
- **`EXCLUDE { CURRENT ROW | GROUP | TIES | NO OTHERS }`** frame-exclude clause. The `FrameSpec` type has no `exclude` field.
- **`PERCENTILE_CONT` / `PERCENTILE_DISC`** (inverse-distribution aggregates with `WITHIN GROUP`) — top-level `percentileCont()` / `percentileDisc()` builders plus the generic `withinGroup(agg, [...orderBy])` attach the SQL standard ordered-set clause: `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_ms)`. Emitted on PG, MySQL 8, MSSQL. SQLite has no equivalent (`assertFeature("sqlite", "ORDERED_SET_AGGREGATES")` throws). ✅

## JSON / SQL:2016 + 2023

Sumak's JSON surface (`src/builder/eb.ts`):

- `jsonAgg`, `toJson`, `jsonBuildObject` (PG-only).
- `jsonRef` for PG path-extraction operators (`->`, `->>`, `#>`, `#>>`).

**SQL:2023 standard JSON functions we don't have:**

- **`JSON_VALUE(expr, path RETURNING type)`** — extract scalar with type casting.
- **`JSON_QUERY(expr, path)`** — extract JSON sub-document.
- **`JSON_EXISTS(expr, path)`** — boolean test for path existence.
- **`JSON_TABLE(expr, path COLUMNS (…))`** — pivot JSON array into a relation (table-valued function). PG 17 added it; MySQL 8 has had it; MSSQL `OPENJSON` is the closest.
- **`IS JSON [SCALAR | ARRAY | OBJECT]`** predicate.

These are all standardized but uniformly opt-in across DB engines — adding builder helpers makes most sense once at least PG and MySQL share the same shape. Today the safest user-land path is `unsafeRawExpr("JSON_VALUE(...)", [...])`.

## Other 2023-flavor features

- **`UNIQUE NULLS NOT DISTINCT`** in unique constraints — PG 15+. Sumak supports it on column-level (`text().unique({ nullsNotDistinct: true })`) and table-level (`{ uniques: [{ columns, nullsNotDistinct: true }] }`) constraints. The diff engine threads the flag onto `ColumnDefinitionNode.uniqueNullsNotDistinct` / `UniqueConstraintNode.nullsNotDistinct`; the DDL printer emits `UNIQUE NULLS NOT DISTINCT` on PG and throws `UnsupportedDialectFeatureError` on MySQL/SQLite/MSSQL. ✅
- **`ANY_VALUE(expr)`** aggregate — accepted on PG 16+; not in the allowlist (would just need adding to `KNOWN_FUNCTIONS`).
- **`STRING_AGG` ordering inside the aggregate** — sumak has this via `aggOrderBy`, but the SQL:2023 syntax is `STRING_AGG(expr, sep ORDER BY …)` which our printer already emits correctly. ✅
- **`GROUPING SETS` / `CUBE` / `ROLLUP`** — pre-2023 but recently added on the sumak side; present in `groupBy`. ✅

## Summary

Sumak's coverage is roughly "core SQL:2016 + vendor-portable parts of SQL:2023". The named `WINDOW` clause and `JSON_TABLE` are the two most-likely-to-be-requested gaps; everything else is either niche or trivially reachable via `unsafeRawExpr`. If you find a gap that affects your use case, open an issue with the exact statement you want to compile and the dialect — that pins down the AST change needed.
