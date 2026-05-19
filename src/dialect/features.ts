import { UnsupportedDialectFeatureError } from "../errors.ts"
import type { SQLDialect } from "../types.ts"

/**
 * Central dialect-feature matrix.
 *
 * Every entry names one SQL feature (SQL:*, vendor extension, or AST
 * node) and lists the dialects that support it. Printers and DDL
 * builders check support with {@link supportsFeature} or the
 * {@link assertFeature} guard, so "does MySQL support RETURNING?"
 * has exactly one answer, in one file.
 *
 * **Adding a feature.** Append an entry below with the right set of
 * supporting dialects. If the support is conditional (MySQL 8 yes, 5.7
 * no; PG for some lock modes only), put the *unconditional* support in
 * the matrix and keep the fine-grained guard inside the printer — the
 * matrix is a coarse first gate.
 *
 * **Renaming user-facing strings.** The human-readable feature name
 * travels into `UnsupportedDialectFeatureError.message`. Changing it is
 * a user-visible break.
 *
 * Naming convention: SCREAMING_SNAKE_CASE identifier, short user-facing
 * label. Group by area (see section comments).
 */
export type FeatureDef = {
  readonly label: string
  readonly dialects: readonly SQLDialect[]
}

export const FEATURES = {
  // ── DML behavior ──────────────────────────────────────────────────
  RETURNING: { label: "RETURNING", dialects: ["pg", "sqlite"] },
  RETURNING_UPDATE: { label: "RETURNING on UPDATE", dialects: ["pg", "sqlite"] },
  RETURNING_DELETE: { label: "RETURNING on DELETE", dialects: ["pg", "sqlite"] },
  DISTINCT_ON: { label: "DISTINCT ON", dialects: ["pg"] },
  BETWEEN_SYMMETRIC: { label: "BETWEEN SYMMETRIC", dialects: ["pg"] },
  IS_DISTINCT_FROM: { label: "IS DISTINCT FROM", dialects: ["pg", "sqlite"] },
  ILIKE: { label: "ILIKE", dialects: ["pg"] },
  LATERAL_JOIN: { label: "LATERAL JOIN", dialects: ["pg", "mysql"] },
  FULL_OUTER_JOIN: { label: "FULL OUTER JOIN", dialects: ["pg", "mssql", "sqlite"] },

  // ── Upsert / conflict ─────────────────────────────────────────────
  ON_CONFLICT: { label: "ON CONFLICT", dialects: ["pg", "sqlite"] },
  ON_CONFLICT_CONSTRAINT: { label: "ON CONFLICT ON CONSTRAINT", dialects: ["pg"] },
  ON_DUPLICATE_KEY_UPDATE: { label: "ON DUPLICATE KEY UPDATE", dialects: ["mysql"] },
  INSERT_OR_IGNORE: {
    label: "INSERT OR IGNORE / OR REPLACE",
    dialects: ["sqlite", "mysql"],
  },
  /**
   * `OVERRIDING { SYSTEM | USER } VALUE` on INSERT — SQL:2003 clause
   * that controls user-supplied values for identity columns. PG (10+)
   * supports both forms natively. MSSQL has the separate `SET
   * IDENTITY_INSERT` *statement* with similar effect for SYSTEM (no
   * USER equivalent); MySQL and SQLite have no analogue at all (their
   * auto-increment columns accept user values directly). Non-PG
   * dialects throw when this clause is set.
   */
  INSERT_OVERRIDING: { label: "OVERRIDING SYSTEM/USER VALUE", dialects: ["pg"] },
  MERGE_STATEMENT: { label: "MERGE", dialects: ["pg", "mssql"] },
  /**
   * `RETURNING` projection on MERGE — PG 17+ accepts the standard
   * form (including the PG-only `merge_action()` projection). MSSQL
   * has the equivalent `OUTPUT` clause; the MSSQL printer rewrites
   * the `MergeNode.returning` slot as `OUTPUT $action, INSERTED.col,
   * DELETED.col` at emit time (the `$action` token is exposed via the
   * dedicated `mergeActionMssql()` helper — `mergeAction()` itself
   * emits PG-specific `MERGE_ACTION()`). MySQL/SQLite have no MERGE.
   */
  MERGE_RETURNING: { label: "RETURNING / OUTPUT on MERGE", dialects: ["pg", "mssql"] },

  // ── Row locking ───────────────────────────────────────────────────
  FOR_UPDATE: { label: "FOR UPDATE/SHARE", dialects: ["pg", "mysql"] },
  FOR_NO_KEY_UPDATE: { label: "FOR NO KEY UPDATE / FOR KEY SHARE", dialects: ["pg"] },
  FOR_UPDATE_OF: { label: "FOR UPDATE OF", dialects: ["pg"] },
  SKIP_LOCKED: { label: "SKIP LOCKED", dialects: ["pg", "mysql"] },
  NOWAIT: { label: "NOWAIT", dialects: ["pg", "mysql"] },

  // ── Window functions ──────────────────────────────────────────────
  WINDOW_FUNCTIONS: { label: "window functions", dialects: ["pg", "mysql", "sqlite", "mssql"] },
  WINDOW_FRAME_ROWS: { label: "ROWS frame", dialects: ["pg", "mysql", "sqlite", "mssql"] },
  WINDOW_FRAME_RANGE: { label: "RANGE frame", dialects: ["pg", "mysql", "sqlite", "mssql"] },
  WINDOW_FRAME_GROUPS: { label: "GROUPS frame", dialects: ["pg", "sqlite"] },
  /**
   * `EXCLUDE { CURRENT ROW | GROUP | TIES | NO OTHERS }` frame-exclude
   * clause (SQL:2011). PG and SQLite accept all four options; MySQL 8
   * and MSSQL have no equivalent grammar.
   */
  FRAME_EXCLUDE: { label: "EXCLUDE frame clause", dialects: ["pg", "sqlite"] },

  // ── Aggregates ────────────────────────────────────────────────────
  FILTER_WHERE: { label: "aggregate FILTER (WHERE …)", dialects: ["pg", "sqlite"] },
  STRING_AGG: { label: "STRING_AGG", dialects: ["pg", "mssql"] },
  GROUP_CONCAT: { label: "GROUP_CONCAT", dialects: ["mysql", "sqlite"] },
  ARRAY_AGG: { label: "ARRAY_AGG", dialects: ["pg"] },
  /**
   * SQL standard ordered-set aggregates — `PERCENTILE_CONT`,
   * `PERCENTILE_DISC`, `MODE` etc. with the `WITHIN GROUP (ORDER BY
   * …)` clause. PG, MySQL 8 (`PERCENTILE_*` only), MSSQL accept the
   * standard form. SQLite has no equivalent.
   */
  ORDERED_SET_AGGREGATES: {
    label: "ordered-set aggregates (WITHIN GROUP)",
    dialects: ["pg", "mysql", "mssql"],
  },
  /**
   * Univariate statistical aggregates under the **standard names**
   * `STDDEV`, `STDDEV_POP`, `STDDEV_SAMP`. PG, MySQL, and SQLite (3.41+
   * via the math extension) accept these spellings. MSSQL is excluded
   * — its native T-SQL spellings are `STDEV` (sample) and `STDEVP`
   * (population) with no `STDDEV_*` aliases at all; a literal `STDDEV`
   * is a parse error. If you need MSSQL std-dev today, use
   * `sqlFn("STDEV", expr)` / `sqlFn("STDEVP", expr)`.
   */
  STDDEV_FN: {
    label: "STDDEV / STDDEV_POP / STDDEV_SAMP",
    dialects: ["pg", "mysql", "sqlite"],
  },
  /**
   * See {@link STDDEV_FN}. Same MSSQL caveat applies — T-SQL has
   * `VAR` / `VARP` (no `VARIANCE_*` aliases), so MSSQL is excluded
   * from this flag; reach for `sqlFn("VAR", expr)` / `sqlFn("VARP",
   * expr)` instead.
   */
  VARIANCE_FN: {
    label: "VARIANCE / VAR_POP / VAR_SAMP",
    dialects: ["pg", "mysql", "sqlite"],
  },
  /**
   * Bivariate linear-regression aggregates — `CORR`, `COVAR_POP`,
   * `COVAR_SAMP`, `REGR_SLOPE`, `REGR_INTERCEPT`, `REGR_R2`. PG
   * implements the full set under the standard names. **MSSQL has
   * none of these as built-ins** — hand-rolling via `SUM` / `AVG`
   * with the variance/covariance identities is the only path on
   * T-SQL. MySQL and SQLite likewise lack them. The printer refuses
   * on every non-PG dialect rather than emit SQL the engine rejects.
   */
  LINEAR_REGRESSION_AGG: {
    label: "linear-regression aggregates (CORR / COVAR_* / REGR_*)",
    dialects: ["pg"],
  },

  // ── Arrays / JSON ─────────────────────────────────────────────────
  ARRAY_LITERALS: { label: "ARRAY[...]", dialects: ["pg"] },
  ARRAY_CONTAINS_OPS: { label: "array operators (@>, <@, &&)", dialects: ["pg"] },
  /**
   * PG array function-call helpers — `array_append`, `array_prepend`,
   * `array_cat`, `array_length`, `array_positions`, `array_position`,
   * `array_remove`, `array_replace`, `array_to_string`, and `unnest`.
   * All ten share the same PG-only support: MySQL / SQLite / MSSQL have
   * no first-class array type, so none of these functions exist on them
   * under the same names with the same semantics. A user-defined
   * function with one of these names would have a colliding signature
   * and silently mis-evaluate; the printer refuses on every non-PG
   * dialect so the failure points at the builder call.
   */
  PG_ARRAY_FNS: {
    label: "PostgreSQL array functions (array_append / array_cat / unnest / …)",
    dialects: ["pg"],
  },
  /**
   * `col <op> ANY/ALL (subquery)`. PG supports all six comparison
   * ops; MySQL 8 supports the subquery-operand form; MSSQL and
   * SQLite reject both.
   */
  QUANTIFIED_SUBQUERY: { label: "ANY/ALL subquery", dialects: ["pg", "mysql"] },
  /**
   * `col <op> ANY/ALL (ARRAY[...])` — array-operand form. PG only;
   * MySQL accepts subquery form but not this one.
   */
  QUANTIFIED_ARRAY: { label: "ANY/ALL array operand", dialects: ["pg"] },

  /**
   * `GROUP BY GROUPING SETS ((a, b), (a), ())`. PG + MSSQL only.
   * MySQL has no `GROUPING SETS` construct; SQLite added CUBE and
   * ROLLUP in 3.46 but not GROUPING SETS.
   */
  GROUPING_SETS: { label: "GROUPING SETS", dialects: ["pg", "mssql"] },
  /** `GROUP BY CUBE(a, b)`. PG + MSSQL + SQLite 3.46+. */
  GROUPING_CUBE: { label: "CUBE", dialects: ["pg", "mssql", "sqlite"] },
  /**
   * `GROUP BY ROLLUP(a, b)`. PG + MSSQL + SQLite 3.46+. MySQL has
   * the same semantics under a different syntax (`GROUP BY a, b WITH
   * ROLLUP`) — not surfaced via `GROUPING_ROLLUP` because emitting
   * the standard form on MySQL would fail at parse. MySQL users can
   * write `WITH ROLLUP` via `unsafeRawExpr` today; a dedicated
   * builder switch is a follow-up.
   */
  GROUPING_ROLLUP: { label: "ROLLUP", dialects: ["pg", "mssql", "sqlite"] },
  JSON_ARROW: { label: "-> / ->> JSON operators", dialects: ["pg"] },
  JSON_PATH_ARROW: { label: "#> / #>> JSON path operators", dialects: ["pg"] },
  JSONB: { label: "JSONB", dialects: ["pg"] },
  /**
   * `expr IS [NOT] JSON [VALUE|SCALAR|ARRAY|OBJECT]` — SQL:2016
   * predicate. PG 16+, MySQL 8 (uses JSON_VALID under the hood for
   * the same effect, but the literal predicate parses), MSSQL all
   * accept the standard form. SQLite has no equivalent and the
   * printer refuses.
   */
  IS_JSON_PREDICATE: { label: "IS JSON predicate", dialects: ["pg", "mysql", "mssql"] },
  /**
   * `JSON_VALUE(json_expr, '$.path' [RETURNING type])` — SQL:2016
   * scalar JSON extraction. PG 17+, MySQL 8, MSSQL accept the bare
   * form; PG 17+ and MySQL 8 also accept the `RETURNING type` clause
   * (MSSQL always returns nvarchar(4000), and the printer refuses a
   * non-empty `returningType`). SQLite has no direct equivalent
   * (`json_extract` differs on both path grammar and the
   * missing-vs-null semantics) and the printer refuses.
   */
  JSON_VALUE_FN: { label: "JSON_VALUE function", dialects: ["pg", "mysql", "mssql"] },
  /**
   * `JSON_QUERY(json_expr, '$.path' [RETURNING type])` — SQL:2016
   * JSON-typed extraction (returns JSON / JSONB rather than a coerced
   * scalar). PG 17+ accepts both the bare and `RETURNING` forms;
   * MSSQL accepts only the bare form (its `JSON_QUERY` always returns
   * nvarchar). MySQL 8 has no `JSON_QUERY` — `JSON_EXTRACT` is the
   * closest fit. SQLite has no equivalent at all.
   */
  JSON_QUERY_FN: { label: "JSON_QUERY function", dialects: ["pg", "mssql"] },
  /**
   * `JSON_EXISTS(json_expr, '$.path')` — SQL:2016 boolean predicate
   * that returns TRUE when the path resolves to a value in the JSON
   * document. PG 17+, MSSQL accept the standard syntax. MySQL has
   * `JSON_CONTAINS_PATH` with different argument shape (no native
   * `JSON_EXISTS`), and SQLite has nothing equivalent — both refuse
   * via this flag.
   */
  JSON_EXISTS_FN: { label: "JSON_EXISTS function", dialects: ["pg", "mssql"] },

  // ── Full-text search ──────────────────────────────────────────────
  FTS_TSVECTOR: { label: "to_tsvector / to_tsquery", dialects: ["pg"] },
  FTS_MATCH: { label: "MATCH AGAINST", dialects: ["mysql"] },
  FTS_SQLITE_MATCH: { label: "FTS5 MATCH", dialects: ["sqlite"] },
  FTS_MSSQL_CONTAINS: { label: "CONTAINS", dialects: ["mssql"] },

  // ── Regex functions ───────────────────────────────────────────────
  /**
   * `REGEXP_REPLACE(haystack, pattern, replacement[, flags])` —
   * search-and-replace by regex. PG (since 7.4) and MySQL 8 ship it
   * under the standard name. SQLite has a `regexp_replace` only when
   * built with the `regexp` extension (e.g. `SQLITE_ENABLE_REGEXP`);
   * we still list SQLite as supported here because the parser
   * accepts the call — the failure surfaces at execution if the
   * extension is absent, which matches sumak's policy of trusting
   * the engine for extension presence. MSSQL has no equivalent
   * built-in (`STRING_AGG` does not regex-replace and `LIKE` is a
   * glob, not a regex); the printer refuses.
   */
  REGEXP_REPLACE_FN: { label: "REGEXP_REPLACE", dialects: ["pg", "mysql", "sqlite"] },
  /**
   * `REGEXP_LIKE(haystack, pattern[, flags])` — boolean regex test.
   * PG 15+ ships the standard function name (`regexp_like(text,
   * pattern[, flags])`); older PG users have only the `~` / `~*`
   * operators. MySQL 8 implements `REGEXP_LIKE(expr, pat[,
   * match_type])`. SQLite exposes the same semantics through the
   * `REGEXP` operator (only when the regexp extension is loaded) but
   * has no `regexp_like` function — the printer refuses so callers
   * pick the operator form explicitly. MSSQL has neither.
   */
  REGEXP_LIKE_FN: { label: "REGEXP_LIKE", dialects: ["pg", "mysql"] },
  /**
   * PG `regexp_matches(haystack, pattern[, flags])` — returns a
   * `text[]` of captured groups (and is set-returning under the `g`
   * flag). **PG-only**: MySQL has `REGEXP_SUBSTR` which returns just
   * the matched substring (no group breakdown); SQLite and MSSQL
   * have no equivalent at all.
   */
  REGEXP_MATCHES_FN: { label: "REGEXP_MATCHES", dialects: ["pg"] },
  /**
   * `REGEXP_SUBSTR(haystack, pattern[, position[, occurrence[,
   * flags]]])` — extract the first (or Nth) regex match. PG 15+ and
   * MySQL 8 both ship the function with the same shape (PG calls it
   * `regexp_substr`; both engines accept the standard name and
   * argument order). SQLite has no `REGEXP_SUBSTR`; MSSQL likewise
   * has no native equivalent.
   */
  REGEXP_SUBSTR_FN: { label: "REGEXP_SUBSTR", dialects: ["pg", "mysql"] },

  // ── String functions ──────────────────────────────────────────────
  /**
   * SQL standard `OVERLAY(<target> PLACING <repl> FROM <from> [FOR
   * <count>])` — substring replace by position. PG, MSSQL (2017+), and
   * MySQL 8 (8.0.4+) accept the standard form natively. SQLite has no
   * equivalent — the SQLite printer refuses. The MSSQL printer emits
   * the standard keyword form (MSSQL parses it 1:1 since 2017).
   */
  OVERLAY_FN: { label: "OVERLAY", dialects: ["pg", "mysql", "mssql"] },

  // ── Date/time functions ───────────────────────────────────────────
  /**
   * SQL standard `EXTRACT(<field> FROM <expr>)`. All four dialects
   * accept the standard form for the common fields (YEAR, MONTH, DAY,
   * HOUR, MINUTE, SECOND), but the *recognized* field set differs:
   * PG has the richest list (DOW, DOY, EPOCH, ISOYEAR, ISODOW, etc.);
   * SQLite implements EXTRACT via strftime-equivalents and accepts a
   * narrower subset; MSSQL maps it to DATEPART; MySQL accepts the
   * standard fields. Unrecognised fields fail at parse — the printer
   * does not gate per-field, only per-presence.
   */
  EXTRACT_FN: { label: "EXTRACT", dialects: ["pg", "mysql", "sqlite", "mssql"] },
  /**
   * PG `DATE_TRUNC(unit, ts)` — round a timestamp down to the named
   * unit ('year', 'month', 'day', …). PG only; MSSQL has `DATETRUNC`
   * with a different shape and reversed argument types (identifier
   * field, not a string literal). MySQL/SQLite have no equivalent.
   */
  DATE_TRUNC_FN: { label: "DATE_TRUNC", dialects: ["pg"] },
  /**
   * PG `AGE(end, start)` / `AGE(now, start)` — returns an interval
   * difference between two timestamps. PG only — no portable
   * equivalent on the other dialects (MySQL's `TIMESTAMPDIFF` returns
   * a numeric in chosen units; MSSQL's `DATEDIFF` similarly).
   */
  AGE_FN: { label: "AGE", dialects: ["pg"] },

  // ── Math ──────────────────────────────────────────────────────────
  /**
   * `PI()` — the niladic constant function. PG / MySQL / MSSQL all
   * ship it natively. **SQLite has no built-in `PI`** — the constant
   * needs to be written as a literal (`3.141592653589793`) or computed
   * via `acos(-1)` (which requires SQLite 3.35+). The printer refuses
   * rather than emit a call SQLite will reject as "no such function".
   */
  PI_FN: { label: "PI()", dialects: ["pg", "mysql", "mssql"] },
  /**
   * Trigonometric and angle-unit-conversion built-ins — `SIN`, `COS`,
   * `TAN`, `DEGREES`, `RADIANS`. PG / MySQL / MSSQL ship them
   * unconditionally; SQLite added them in **3.35** alongside the rest
   * of the math-extension built-ins. Older SQLite builds reject the
   * names at parse — the printer can't gate per-version, so engines
   * older than 3.35 will surface a driver-level "no such function"
   * error. The feature is gated as available on `sqlite` because the
   * supported version line for sumak is 3.35+.
   */
  TRIGONOMETRY_FNS: {
    label: "SIN / COS / TAN / DEGREES / RADIANS",
    dialects: ["pg", "mysql", "sqlite", "mssql"],
  },

  // ── Temporal ──────────────────────────────────────────────────────
  TEMPORAL_FOR_SYSTEM_TIME: {
    label: "FOR SYSTEM_TIME (SQL:2011 temporal tables)",
    dialects: ["mssql"],
  },

  // ── DDL ───────────────────────────────────────────────────────────
  IF_NOT_EXISTS_TABLE: { label: "CREATE TABLE IF NOT EXISTS", dialects: ["pg", "mysql", "sqlite"] },
  IF_EXISTS_DROP: { label: "DROP ... IF EXISTS", dialects: ["pg", "mysql", "sqlite"] },
  RENAME_COLUMN: {
    label: "ALTER TABLE RENAME COLUMN",
    dialects: ["pg", "mysql", "sqlite", "mssql"],
  },
  /** `CREATE VIEW … AS <select>`. SQL standard — every dialect ships it. */
  CREATE_VIEW: { label: "CREATE VIEW", dialects: ["pg", "mysql", "sqlite", "mssql"] },
  /**
   * `CREATE OR REPLACE VIEW` — PG / MySQL / SQLite emit the standard
   * form. MSSQL's analogue is `CREATE OR ALTER VIEW` (2016-SP1+), which
   * the DDL printer emits when this flag is set on the node and the
   * dialect is `mssql` — the divergence is handled at print time, not
   * via the feature matrix. SQLite has no `OR REPLACE` and no `OR
   * ALTER`; the printer refuses there with a pointer at the DROP+CREATE
   * workaround. The matrix excludes MSSQL because the user-facing
   * keyword differs; callers who need MSSQL emit via the same builder
   * (`createView(...).orReplace()`) and rely on the printer rewrite.
   */
  OR_REPLACE_VIEW: { label: "CREATE OR REPLACE VIEW", dialects: ["pg", "mysql"] },
  MATERIALIZED_VIEW: { label: "MATERIALIZED VIEW", dialects: ["pg"] },
  /**
   * `REFRESH MATERIALIZED VIEW CONCURRENTLY` — PG only. Requires a
   * UNIQUE index on the view; without one PG raises at execution time.
   * MySQL / SQLite / MSSQL have no materialized views at all (gated by
   * {@link MATERIALIZED_VIEW}); this flag adds the concurrent-refresh
   * subfeature on top.
   */
  MATERIALIZED_VIEW_CONCURRENT_REFRESH: {
    label: "REFRESH MATERIALIZED VIEW CONCURRENTLY",
    dialects: ["pg"],
  },
  GIN_INDEX: { label: "GIN index", dialects: ["pg"] },
  GIST_INDEX: { label: "GIST index", dialects: ["pg"] },
  PARTIAL_INDEX: { label: "partial index (WHERE)", dialects: ["pg", "sqlite"] },
  /**
   * PG `EXCLUDE` table-level constraint — a generalization of UNIQUE
   * where each element specifies its own commutative operator (`room
   * WITH =, during WITH &&` for range-overlap exclusion). Backed by a
   * GiST / SP-GiST / btree index depending on the operators used.
   * MySQL / SQLite / MSSQL have no equivalent grammar; the closest
   * fit is a unique partial index, which is a different shape (only
   * supports equality) and is best expressed via the partial-index
   * API. The printer refuses on every non-PG dialect.
   */
  EXCLUDE_CONSTRAINTS: { label: "EXCLUDE constraint", dialects: ["pg"] },
  CASCADE_DROP: { label: "DROP ... CASCADE", dialects: ["pg"] },
  /**
   * `COMMENT ON TABLE` / `COMMENT ON COLUMN` (PG syntax) and the
   * equivalent MySQL forms (`ALTER TABLE … COMMENT = '…'` for table
   * comments; inline `<col_def> COMMENT '…'` for column comments
   * inside `CREATE TABLE`). PG and MySQL only — MSSQL uses the
   * separate `sp_addextendedproperty` stored procedure (out of scope)
   * and SQLite has no equivalent at all (the keyword is accepted as a
   * no-op in some grammars but not portably). The DDL printer refuses
   * on the unsupported dialects rather than emit silent no-ops.
   */
  OBJECT_COMMENTS: { label: "COMMENT ON TABLE / COLUMN", dialects: ["pg", "mysql"] },
  /**
   * `CREATE SEQUENCE` / `DROP SEQUENCE` — first-class sequence objects.
   * PG and MSSQL both ship a standard-compliant grammar (PG's superset
   * is broader: `OWNED BY`, `IF NOT EXISTS`, `CACHE` with explicit `NO
   * CACHE`). MySQL and SQLite have no sequence object at all — they
   * only support inline `AUTO_INCREMENT` / `AUTOINCREMENT` on a column.
   * The DDL printer refuses on the unsupported dialects rather than
   * emit a statement the engine will reject.
   */
  SEQUENCES: { label: "CREATE SEQUENCE / DROP SEQUENCE", dialects: ["pg", "mssql"] },
  /**
   * Runtime sequence helpers — `nextval('seq')`, `currval('seq')`,
   * `setval('seq', n[, is_called])`. PG only; these are the PG-native
   * function-shape access path to a sequence. MSSQL uses a different
   * grammar (`NEXT VALUE FOR <seq>`) which is not a function call —
   * supporting it cleanly needs a dedicated AST node and a separate
   * pass. For the first cut we expose only the PG forms.
   */
  SEQUENCE_FNS: { label: "nextval / currval / setval", dialects: ["pg"] },

  // ── TCL (transactions) ────────────────────────────────────────────
  TX_ISOLATION_INLINE: {
    label: "inline BEGIN ISOLATION LEVEL",
    dialects: ["pg"],
  },
  TX_READ_ONLY_INLINE: { label: "inline BEGIN READ ONLY", dialects: ["pg", "mysql"] },
  TX_COMMIT_CHAIN: { label: "COMMIT AND CHAIN", dialects: ["pg", "mysql"] },
  TX_ROLLBACK_CHAIN: { label: "ROLLBACK AND CHAIN", dialects: ["pg", "mysql"] },
  TX_CONSISTENT_SNAPSHOT: { label: "WITH CONSISTENT SNAPSHOT", dialects: ["mysql"] },
  TX_SQLITE_LOCKING: { label: "SQLite BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE", dialects: ["sqlite"] },
  TX_DEFERRABLE: { label: "DEFERRABLE transaction", dialects: ["pg"] },
  TX_RELEASE_SAVEPOINT: { label: "RELEASE SAVEPOINT", dialects: ["pg", "mysql", "sqlite"] },
  TX_SNAPSHOT_ISOLATION: { label: "SNAPSHOT isolation", dialects: ["mssql"] },

  // ── EXPLAIN ───────────────────────────────────────────────────────
  EXPLAIN_ANALYZE: { label: "EXPLAIN ANALYZE", dialects: ["pg", "mysql", "sqlite"] },
  EXPLAIN_JSON: { label: "EXPLAIN (FORMAT JSON)", dialects: ["pg", "mysql"] },
  EXPLAIN_YAML: { label: "EXPLAIN (FORMAT YAML)", dialects: ["pg"] },
  EXPLAIN_XML: { label: "EXPLAIN (FORMAT XML)", dialects: ["pg"] },
  EXPLAIN_TREE: { label: "EXPLAIN TREE", dialects: ["mysql"] },
} as const satisfies Record<string, FeatureDef>

export type FeatureKey = keyof typeof FEATURES

/** True iff `dialect` appears in the feature's supported list. */
export function supportsFeature(dialect: SQLDialect, feature: FeatureKey): boolean {
  return (FEATURES[feature].dialects as readonly SQLDialect[]).includes(dialect)
}

/**
 * Throw {@link UnsupportedDialectFeatureError} if `dialect` is not in the
 * feature's supported list. Use at the printer entry point for any
 * clause that has unambiguous per-dialect availability.
 */
export function assertFeature(dialect: SQLDialect, feature: FeatureKey): void {
  if (!supportsFeature(dialect, feature)) {
    throw new UnsupportedDialectFeatureError(dialect, FEATURES[feature].label)
  }
}

/**
 * Returns the sorted list of dialects that support `feature`. Useful
 * for error messages ("supported by: pg, mysql") and for parity-matrix
 * tests that iterate dialect/feature pairs.
 */
export function dialectsForFeature(feature: FeatureKey): readonly SQLDialect[] {
  return FEATURES[feature].dialects
}
