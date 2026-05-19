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
  "VARIANCE",
  "STRING_AGG",
  "GROUP_CONCAT",
  "ARRAY_AGG",
  "JSON_AGG",
  "JSONB_AGG",
  "JSON_OBJECT_AGG",
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
  // JSON
  "JSON_BUILD_OBJECT",
  "JSONB_BUILD_OBJECT",
  "JSON_BUILD_ARRAY",
  "TO_JSON",
  "TO_JSONB",
  // Full-text
  "FREETEXT",
  "CONTAINS",
])
