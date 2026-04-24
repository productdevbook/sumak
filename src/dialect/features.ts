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
  MERGE_STATEMENT: { label: "MERGE", dialects: ["pg", "mssql"] },

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

  // ── Aggregates ────────────────────────────────────────────────────
  FILTER_WHERE: { label: "aggregate FILTER (WHERE …)", dialects: ["pg", "sqlite"] },
  STRING_AGG: { label: "STRING_AGG", dialects: ["pg", "mssql"] },
  GROUP_CONCAT: { label: "GROUP_CONCAT", dialects: ["mysql", "sqlite"] },
  ARRAY_AGG: { label: "ARRAY_AGG", dialects: ["pg"] },

  // ── Arrays / JSON ─────────────────────────────────────────────────
  ARRAY_LITERALS: { label: "ARRAY[...]", dialects: ["pg"] },
  ARRAY_CONTAINS_OPS: { label: "array operators (@>, <@, &&)", dialects: ["pg"] },
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

  // ── Full-text search ──────────────────────────────────────────────
  FTS_TSVECTOR: { label: "to_tsvector / to_tsquery", dialects: ["pg"] },
  FTS_MATCH: { label: "MATCH AGAINST", dialects: ["mysql"] },
  FTS_SQLITE_MATCH: { label: "FTS5 MATCH", dialects: ["sqlite"] },
  FTS_MSSQL_CONTAINS: { label: "CONTAINS", dialects: ["mssql"] },

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
  MATERIALIZED_VIEW: { label: "MATERIALIZED VIEW", dialects: ["pg"] },
  GIN_INDEX: { label: "GIN index", dialects: ["pg"] },
  GIST_INDEX: { label: "GIST index", dialects: ["pg"] },
  PARTIAL_INDEX: { label: "partial index (WHERE)", dialects: ["pg", "sqlite"] },
  CASCADE_DROP: { label: "DROP ... CASCADE", dialects: ["pg"] },

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
