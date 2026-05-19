# Changelog

All notable changes to **sumak** are documented here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/), grouped by feature area instead of strict
chronological order so it stays scannable as the surface grows.

The entries under **[Unreleased]** are merged on `main` but have not yet been cut as a
versioned release — `package.json` still reads `0.0.15`. Maintainers cut a release with
`pnpm release`; this file should not edit the `version` field itself.

Each entry links to its PR and notes the dialect support in parentheses, using these
shorthand tags:

- **all four** — PostgreSQL + MySQL + SQLite + MSSQL
- **PG / MySQL / SQLite / MSSQL** — individual dialect names listed when support is partial
- **PG-only** — the feature has no portable analogue on the other three dialects

Dialect refusals are enforced through the central feature-flag matrix — calling an
unsupported builder against the wrong dialect throws `UnsupportedDialectFeatureError`
at compile time, not at runtime.

## [Unreleased]

### SQL Functions — Aggregates

- [#142](https://github.com/productdevbook/sumak/pull/142) — `anyValue(expr)` SQL:2023 aggregate that returns an arbitrary non-null group value (PG 16+ / MySQL 8 / SQLite — refused on MSSQL).
- [#146](https://github.com/productdevbook/sumak/pull/146) — `percentileCont(n)` / `percentileDisc(n)` ordered-set aggregates plus a generic `withinGroup(agg, [{ expr, direction }])` helper that attaches `WITHIN GROUP (ORDER BY …)` to any function call (PG / MySQL / MSSQL — SQLite refuses).
- [#156](https://github.com/productdevbook/sumak/pull/156) — Statistical aggregates: `stddev` / `stddevPop` / `stddevSamp` / `variance` / `variancePop` / `varianceSamp` (all four), and linear-regression aggregates `corr` / `covarPop` / `covarSamp` / `regrSlope` / `regrIntercept` / `regrR2` (PG + MSSQL only).
- [#167](https://github.com/productdevbook/sumak/pull/167) — Bit aggregates `bitAnd` / `bitOr` (PG / MySQL / SQLite 3.44+) and `bitXor` (MySQL-only); boolean aggregates `boolAnd` / `boolOr` (PG / SQLite 3.45+); window-only value helpers `firstValue` / `lastValue` / `nthValue` (all four).

### SQL Functions — String

- [#164](https://github.com/productdevbook/sumak/pull/164) — `replace` / `position` / `overlay` / `ltrim` / `rtrim` / `reverse` typed string builders. `position` rewrites to `CHARINDEX` on MSSQL; all six available on **all four** dialects.

### SQL Functions — Math

- [#165](https://github.com/productdevbook/sumak/pull/165) — Typed math builders under the `num.*` namespace: `power` / `sqrt` / `ln` / `log` / `exp` / `sign` / `pi` / `degrees` / `radians` / `sin` / `cos` / `tan`. MSSQL's `LN` divergence is normalised at print time (all four).

### SQL Functions — Date / Time

- [#155](https://github.com/productdevbook/sumak/pull/155) — `extract(field, expr)` / `dateTrunc(unit, expr)` / `age(a, b)` typed date-arithmetic builders. `extract` is portable across all four dialects via the `EXTRACT_FN` feature flag; `dateTrunc` and `age` follow the standard PG path with dialect-specific rewrites where available.
- [#159](https://github.com/productdevbook/sumak/pull/159) — `dateAdd(expr, n, unit)` / `dateSub(expr, n, unit)` with a closed unit enum (`year | month | week | day | hour | minute | second`). Each printer emits its native syntax: `INTERVAL` on PG, `DATE_ADD` on MySQL, `DATEADD` on MSSQL, `datetime(..., '+n days')` on SQLite (all four).

### SQL Functions — JSON

- [#149](https://github.com/productdevbook/sumak/pull/149) — `jsonValue(jsonExpr, path, { returning? })` per SQL:2016 (PG 17+ / MySQL 8 / MSSQL — SQLite refuses).
- [#150](https://github.com/productdevbook/sumak/pull/150) — `jsonQuery(jsonExpr, path, { returning? })` and `jsonExists(jsonExpr, path)` (PG 17+ / MSSQL).

### SQL Functions — Regex

- [#162](https://github.com/productdevbook/sumak/pull/162) — Typed regex builders: `regexpReplace` (PG / MySQL 8 / SQLite with regexp ext), `regexpLike` (PG 15+ / MySQL 8), `regexpMatches` (PG-only — returns `text[]`), `regexpSubstr` (PG 15+ / MySQL 8). MSSQL refuses all four.

### SQL Functions — PostgreSQL Arrays

- [#166](https://github.com/productdevbook/sumak/pull/166) — Ten **PG-only** array helpers under the `arr.*` namespace: `arrayAppend`, `arrayPrepend`, `arrayCat`, `arrayLength`, `arrayPosition`, `arrayPositions`, `arrayRemove`, `arrayReplace`, `arrayToString`, `unnest`. Gated by the new `PG_ARRAY_FNS` feature flag.

### SQL Functions — Sequences

- [#163](https://github.com/productdevbook/sumak/pull/163) — `nextval('seq')` / `currval('seq')` / `setval('seq', n[, isCalled])` runtime helpers exposed as flat `sumak` exports (PG-only).

### SQL Functions — Misc

- [#148](https://github.com/productdevbook/sumak/pull/148) — `mergeAction()` top-level helper that emits PG's `MERGE_ACTION()` projection inside MERGE `RETURNING` (PG 17+).
- [#157](https://github.com/productdevbook/sumak/pull/157) — `mergeActionMssql()` helper that emits SQL Server's `$action` pseudo-column (MSSQL-only — kept separate from `mergeAction()` because the two emit different SQL: function call vs. pseudo-column).

### SQL Predicates & Clauses

- [#143](https://github.com/productdevbook/sumak/pull/143) — `UNIQUE NULLS NOT DISTINCT` on column-level (`text().unique({ nullsNotDistinct: true })`) and table-level UNIQUE constraints (PG 15+).
- [#144](https://github.com/productdevbook/sumak/pull/144) — SQL:2016 `IS [NOT] JSON [VALUE | SCALAR | ARRAY | OBJECT]` predicate via `Col<T>.isJson({ kind?, negate? })` and the top-level `isJson(...)` helper (PG 16+ / MySQL 8 / MSSQL — SQLite refuses).
- [#145](https://github.com/productdevbook/sumak/pull/145) — SQL:2003 named `WINDOW` clause via `.window(name, build)` on the SELECT builder, with inheritance support (`.window("w2", b => …, { from: "w" })`). Emit on PG / MySQL / SQLite — MSSQL refuses (no SQL:2003 named-window grammar).
- [#147](https://github.com/productdevbook/sumak/pull/147) — `WHEN NOT MATCHED BY SOURCE` MERGE branch via `whenNotMatchedBySourceUpdate(...)` / `whenNotMatchedBySourceDelete(...)` (PG 17+ / MSSQL).
- [#148](https://github.com/productdevbook/sumak/pull/148) — `RETURNING` on MERGE (`.returning(...)`, `.returningAll()`, aliased-expression form) (PG 17+).
- [#151](https://github.com/productdevbook/sumak/pull/151) — SQL:2011 frame `EXCLUDE { CURRENT ROW | GROUP | TIES | NO OTHERS }` via `.exclude(option)` on `WindowBuilder` (PG / SQLite — MySQL 8 and MSSQL refuse).
- [#152](https://github.com/productdevbook/sumak/pull/152) — SQL:2003 `OVERRIDING { SYSTEM | USER } VALUE` on `InsertBuilder` / `TypedInsertBuilder` via `.overridingSystemValue()` / `.overridingUserValue()` (PG-only).
- [#157](https://github.com/productdevbook/sumak/pull/157) — MSSQL `OUTPUT` clause routed through the same `.returning(...)` slot the PG path uses, so MERGE / INSERT / UPDATE / DELETE all gain `OUTPUT <projections>` on SQL Server. Bare column refs auto-prefix to `INSERTED.*`; explicit `col("x", "DELETED")` overrides for pre-action rows (MSSQL — joins the PG-only `MERGE_RETURNING` matrix).

### DDL — Constraints & Indexes

- [#154](https://github.com/productdevbook/sumak/pull/154) — Partial indexes (`CREATE INDEX ... WHERE <pred>`) wired end-to-end through AST, schema DSL, diff, and DDL printer (PG / SQLite).
- [#160](https://github.com/productdevbook/sumak/pull/160) — PostgreSQL `EXCLUDE` table-level constraints with range-overlap support, optional `WHERE` (partial exclude), and `USING <method>` (defaults to `gist`). Flagship use case: race-free booking-system overlap exclusion (PG-only).

### DDL — Views & Materialized Views

- [#161](https://github.com/productdevbook/sumak/pull/161) — First-class `CREATE VIEW` / `DROP VIEW` plus PG-only `MATERIALIZED VIEW` + `REFRESH MATERIALIZED VIEW`. `.orReplace()` works on PG / MySQL; `.orAlter()` emits `CREATE OR ALTER VIEW` on MSSQL 2016 SP1+. Embedded SELECT bodies route through the full `compile()` pipeline so plugins apply automatically (all four for plain views).

### DDL — Sequences

- [#163](https://github.com/productdevbook/sumak/pull/163) — `CREATE SEQUENCE` / `DROP SEQUENCE` typed DDL (PG / MSSQL).
- [#170](https://github.com/productdevbook/sumak/pull/170) — `ALTER SEQUENCE` typed builder covering `INCREMENT BY`, `MINVALUE` / `NO MINVALUE`, `MAXVALUE` / `NO MAXVALUE`, `START WITH`, `RESTART [WITH n]`, `CACHE` / `NO CACHE`, `CYCLE` / `NO CYCLE`, `AS <type>`, `IF EXISTS`, `OWNED BY … | NONE` (PG / MSSQL).

### DDL — Types & Domains

- [#176](https://github.com/productdevbook/sumak/pull/176) — `CREATE TYPE … AS ENUM` / `DROP TYPE` plus `CREATE DOMAIN` / `DROP DOMAIN` typed builders (PG-only).
- [#178](https://github.com/productdevbook/sumak/pull/178) — `ALTER TYPE … ADD VALUE` with `IF NOT EXISTS` and `BEFORE` / `AFTER` positioning for in-place enum extension (PG-only).
- [#185](https://github.com/productdevbook/sumak/pull/185) — `ALTER TYPE … RENAME TO` and `ALTER TYPE … RENAME VALUE 'old' TO 'new'` (PG 10+ for the value form). Both are catalog-tuple updates — existing references survive (PG-only).

### DDL — Row Level Security

- [#172](https://github.com/productdevbook/sumak/pull/172) — `CREATE POLICY` / `DROP POLICY` typed builders plus the four `ALTER TABLE … {ENABLE | DISABLE | FORCE | NO FORCE} ROW LEVEL SECURITY` toggles on `AlterTableBuilder`. All gated by the single `ROW_LEVEL_SECURITY` feature flag (PG-only).
- [#179](https://github.com/productdevbook/sumak/pull/179) — `ALTER POLICY` typed builder with two mutually-exclusive forms: rename (`.renameTo(newName)`) and modify (`.to(...roles)`, `.using(expr)`, `.withCheck(expr)`) (PG-only).

### DDL — Maintenance

- [#171](https://github.com/productdevbook/sumak/pull/171) — `VACUUM` / `ANALYZE` / `REINDEX` typed builders with full grammar (`.full()`, `.freeze()`, `.verbose()`, etc.) so callers stop reaching for `unsafeRawExpr` and the audit unsafe-node checks stay green (PG-only).
- [#175](https://github.com/productdevbook/sumak/pull/175) — `LOCK TABLE [ONLY] name [, ...] [IN lock_mode MODE] [NOWAIT]` builder with shortcut methods for all eight PG lock modes (`.share()`, `.exclusive()`, ...) (PG-only).

### DDL — Other Schema Objects

- [#158](https://github.com/productdevbook/sumak/pull/158) — `COMMENT ON TABLE` / `COMMENT ON COLUMN` via `.comment("…")` on `ColumnBuilder` and a `comment` option on `defineTable`. PG emits standalone `COMMENT ON …`; MySQL inlines column comments inside `CREATE TABLE` and uses `ALTER TABLE … COMMENT = '…'` for tables (PG / MySQL — SQLite and MSSQL refuse via `OBJECT_COMMENTS`).
- [#168](https://github.com/productdevbook/sumak/pull/168) — `TRUNCATE TABLE` typed builder with full PG grammar (`ONLY`, `RESTART IDENTITY` / `CONTINUE IDENTITY`, `CASCADE` / `RESTRICT`, comma-separated multi-table list). MySQL / MSSQL accept only the simple `TRUNCATE TABLE <name>` form (all four with degraded grammar on the non-PG dialects).
- [#173](https://github.com/productdevbook/sumak/pull/173) — `CREATE EXTENSION` / `DROP EXTENSION` typed DDL with `IF [NOT] EXISTS`, `SCHEMA <name>`, `VERSION '<v>'`, `CASCADE` / `RESTRICT`. Names validated against a strict identifier whitelist (PG-only).
- [#180](https://github.com/productdevbook/sumak/pull/180) — `COPY FROM STDIN` / `COPY TO STDOUT` typed builder for PG bulk transfer. Scoped to driver-streamed `STDIN` / `STDOUT` only — server-side file paths and `PROGRAM 'cmd'` are deliberately not surfaced (PG-only).
- [#181](https://github.com/productdevbook/sumak/pull/181) — `LISTEN <channel>` / `UNLISTEN <channel | *>` / `NOTIFY <channel> [, '<payload>']` typed builders for PG pubsub (PG-only).

### Plugins

- [#169](https://github.com/productdevbook/sumak/pull/169) — `normalizeStrings` plugin: per-column value rewrites on INSERT / UPDATE / MERGE with built-in transforms (`lower`, `upper`, `trim`, `trimStart`, `trimEnd`, `emptyToNull`, `collapseWhitespace`) and arbitrary custom `(value: string) => string | null` chains. Injects at the value layer, not the SQL layer.
- [#177](https://github.com/productdevbook/sumak/pull/177) — `defaults` plugin: generic per-column INSERT-time default value injection via a thunk that fires when `values({...})` omits the column. One level more generic than the hardcoded `audit` plugin — common targets are `tenantId` from request context, generated UUIDs, custom `createdBy` columns.
- [#182](https://github.com/productdevbook/sumak/pull/182) — `validators` plugin: per-column pre-write predicate assertions. Complements `normalizeStrings` (transform) and `defaults` (inject) — `validators` rejects bad input early with a typed `ValidationError`.
- [#183](https://github.com/productdevbook/sumak/pull/183) — `debugLogger` plugin: logs every compiled SQL statement (and optionally every executed call) to a user-supplied sink. Supports `filter`, `slowQueryMs`, custom `sink`, and ANSI colour on the default sink.

### Tests & Bench

- [#153](https://github.com/productdevbook/sumak/pull/153) — Seven cross-library compile-throughput scenarios covering the new SQL surface from PRs #142–151 (RANK, PERCENTILE_CONT, named WINDOW, JSON_VALUE, IS JSON, ANY_VALUE, three-branch MERGE). Sumak uses its typed builders; kysely / drizzle fall back to raw `sql` template literals.
- [#184](https://github.com/productdevbook/sumak/pull/184) — Seven additional bench scenarios for the post-#153 surface (`REGEXP_REPLACE`, `EXTRACT`, `DATE_TRUNC`, grouped `STDDEV`, `POSITION (IN form)`, PG `array_length`, `POWER`). Updates `bench/baseline.json` with conservative floors.
