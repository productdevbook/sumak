/**
 * Function-name allowlists used by the BasePrinter. Split out of
 * `base.ts` so the lookup tables don't take up the first ~110 lines
 * of an already-large file. Pure data — no behavior here.
 */

/**
 * Functions that make sense only inside an `OVER (...)` window
 * clause. Emitting them as a bare call — `ROW_NUMBER()` without
 * `OVER` — is a runtime error on every dialect. The BasePrinter
 * traps the misuse at print time so the bug surfaces in the
 * typechecked build step instead of a driver error.
 */
export const WINDOW_ONLY_FUNCTIONS: ReadonlySet<string> = new Set([
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "PERCENT_RANK",
  "CUME_DIST",
  "NTILE",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTH_VALUE",
])

/**
 * SQL:92 niladic functions — these are spelled as bare keywords,
 * without parentheses, on MSSQL. Other dialects accept either form
 * but the parens-free version is universally portable.
 */
export const NILADIC_FUNCTIONS: ReadonlySet<string> = new Set([
  "CURRENT_TIMESTAMP",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_USER",
  "SESSION_USER",
  "SYSTEM_USER",
  "LOCALTIME",
  "LOCALTIMESTAMP",
])

/**
 * Standard SQL / ANSI built-in functions whose names are
 * traditionally emitted uppercase for portability. Anything NOT in
 * this set is a user-defined function or third-party extension and
 * is emitted verbatim — users can write `"mixedCaseUdf"` or
 * `my_udf` and get back the exact casing they passed, which matters
 * for quoted identifiers in PG / case-sensitive MySQL collations.
 */
export const STANDARD_FUNCTIONS: ReadonlySet<string> = new Set([
  // Aggregates
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "ANY_VALUE",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
  "CORR",
  "COVAR_POP",
  "COVAR_SAMP",
  "REGR_SLOPE",
  "REGR_INTERCEPT",
  "REGR_R2",
  "STRING_AGG",
  "GROUP_CONCAT",
  "ARRAY_AGG",
  "JSON_AGG",
  "JSONB_AGG",
  "JSON_OBJECT_AGG",
  "PERCENTILE_CONT",
  "PERCENTILE_DISC",
  "MODE",
  // Window
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "PERCENT_RANK",
  "CUME_DIST",
  "NTILE",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTH_VALUE",
  // String
  "UPPER",
  "LOWER",
  "CONCAT",
  "SUBSTRING",
  "TRIM",
  "LTRIM",
  "RTRIM",
  "LENGTH",
  "CHAR_LENGTH",
  "REPLACE",
  "POSITION",
  "OVERLAY",
  "REVERSE",
  // Regex
  "REGEXP_REPLACE",
  "REGEXP_LIKE",
  "REGEXP_MATCHES",
  "REGEXP_SUBSTR",
  // Numeric
  "ABS",
  "ROUND",
  "CEIL",
  "CEILING",
  "FLOOR",
  "POWER",
  "SQRT",
  "GREATEST",
  "LEAST",
  "MOD",
  // Conditional
  "COALESCE",
  "NULLIF",
  // Cast / conversion
  "CAST",
  "CONVERT",
  // Date / time
  "EXTRACT",
  "DATE_TRUNC",
  "AGE",
  // JSON
  "JSON_BUILD_OBJECT",
  "JSONB_BUILD_OBJECT",
  "JSON_BUILD_ARRAY",
  "JSON_VALUE",
  "JSON_QUERY",
  "JSON_EXISTS",
  "TO_JSON",
  "TO_JSONB",
  // Full-text
  "FREETEXT",
  "CONTAINS",
  // MERGE projection (PG 17+ only — emits `MERGE_ACTION()` which PG
  // recognizes inside a `RETURNING` clause on a MERGE statement). The
  // function has no analogue on MSSQL (which uses `$action` in its
  // `OUTPUT` clause), so it's only meaningful inside `MERGE … RETURNING`.
  "MERGE_ACTION",
  // Sequence access — PG-only function-shape grammar. The base
  // BasePrinter.printFunctionCall asserts the `SEQUENCE_FNS` feature
  // flag when it sees any of these names, so MySQL / SQLite / MSSQL
  // refuse rather than emit lowercase calls the engines reject. MSSQL
  // has a different grammar (`NEXT VALUE FOR <seq>`) that isn't a
  // function call — supporting it cleanly needs its own AST node.
  "NEXTVAL",
  "CURRVAL",
  "SETVAL",
])

/**
 * Function names that are PG-only and use the function-call grammar.
 * The base printer asserts the `SEQUENCE_FNS` feature flag when it sees
 * any of these names. Kept as a separate set so the lookup is O(1) and
 * the gate fires before the regular argument-rendering path.
 */
export const SEQUENCE_FUNCTIONS: ReadonlySet<string> = new Set(["NEXTVAL", "CURRVAL", "SETVAL"])
