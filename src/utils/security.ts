import { SecurityError } from "../errors.ts"

/**
 * Escapes a string value for safe embedding in a SQL string literal.
 * Handles both single-quote doubling (ANSI SQL) and backslash escaping (MySQL default).
 *
 * This covers the MySQL `BACKSLASH_ESCAPES` sql_mode (enabled by default)
 * where `\'` terminates a string literal, allowing injection even when
 * single quotes are doubled. See: Kysely CVE-2026-33442.
 */
export function escapeStringLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "''")
}

/**
 * Validates that a SQL function name is safe (alphanumeric + underscores only).
 * Prevents injection via arbitrary function names like `sqlFn(userInput, ...)`.
 */
const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateFunctionName(name: string): void {
  if (!SAFE_IDENTIFIER_RE.test(name)) {
    throw new SecurityError(
      `Unsafe SQL function name: "${name}". Function names must be alphanumeric identifiers.`,
    )
  }
}

/**
 * Validates that a PostgreSQL extension name is safe — alphanumeric
 * plus underscore and hyphen (the latter is needed for `uuid-ossp`).
 * Without this guard `CREATE EXTENSION ${userInput}` would land
 * verbatim in DDL, so a payload like `"x; DROP TABLE users; --"` is
 * an immediate injection.
 */
const SAFE_EXTENSION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

export function validateExtensionName(name: string): void {
  if (!SAFE_EXTENSION_NAME_RE.test(name)) {
    throw new SecurityError(
      `Unsafe extension name: "${name}". Extension names must be alphanumeric identifiers (underscore + hyphen allowed).`,
    )
  }
}

/**
 * Validates that an extension VERSION literal is safe. Real PG
 * extension versions are dotted+hyphenated semver-ish strings
 * (`"3.4.2"`, `"1.1-rc1"`) so the regex permits dots and hyphens in
 * addition to alphanumerics + underscores. The string ends up inside
 * a `'…'` SQL literal at print time, but we also gate the contents
 * up front to keep `'; DROP TABLE …` from sneaking into the slot via
 * an unbalanced quote.
 */
const SAFE_EXTENSION_VERSION_RE = /^[A-Za-z0-9._-]+$/

export function validateExtensionVersion(version: string): void {
  if (!SAFE_EXTENSION_VERSION_RE.test(version)) {
    throw new SecurityError(
      `Unsafe extension version: "${version}". Versions must be alphanumeric (dot, underscore, hyphen allowed).`,
    )
  }
}

/**
 * Validates that a CAST data type is safe.
 *
 * Allowed shapes:
 *   - `INTEGER`, `TEXT` (bare identifier)
 *   - `VARCHAR(255)`, `NUMERIC(10, 2)` (base + precision)
 *   - `TIMESTAMP WITH TIME ZONE`, `DOUBLE PRECISION` (multi-word base)
 *   - `TIMESTAMP(6) WITH TIME ZONE` (precision + trailing suffix)
 *   - `INTEGER[]`, `TEXT[]`, `VARCHAR(255)[]` (array suffix)
 *
 * The optional suffix phrase (`WITH TIME ZONE`, etc.) has to allow
 * spaces-and-identifiers without allowing punctuation that could open
 * an injection path (no semicolons, no quotes, no parens after).
 */
const SAFE_DATA_TYPE_RE =
  /^[A-Za-z][A-Za-z0-9_ ]*(?:\([0-9, ]*\))?(?:\s+[A-Za-z][A-Za-z0-9_ ]*)?(?:\[\])?$/

/**
 * Matches an `enum(...)` type where each value is a single-quoted
 * literal whose contents can only contain characters safe in a SQL
 * string literal after `escapeStringLiteral` doubling: any ASCII
 * printable EXCEPT a bare `'` (the enclosing quotes) or `\\`. Allows
 * doubled `''` and escaped `\\\\` as the encoding of the originals.
 * Enum values created via `enumType()` (`src/schema/column.ts`)
 * already flow through escapeStringLiteral; this regex re-verifies
 * that no raw `'` or `\\` sneaked in via direct AST construction.
 */
const SAFE_ENUM_TYPE_RE = /^enum\((?:'(?:''|\\\\|[^'\\])*'(?:,(?:'(?:''|\\\\|[^'\\])*'))*)?\)$/i

export function validateDataType(dataType: string): void {
  if (SAFE_DATA_TYPE_RE.test(dataType)) return
  if (SAFE_ENUM_TYPE_RE.test(dataType)) return
  throw new SecurityError(
    `Unsafe CAST data type: "${dataType}". Data types must be standard SQL type identifiers.`,
  )
}

/**
 * Whitelist of SQL operator tokens allowed in raw splicing positions
 * (currently: PG `EXCLUDE` constraint element operators). Built from
 * the punctuation symbols PG accepts in user-defined and built-in
 * operators (`+ - * / < > = ~ ! @ # % ^ & | ? ` ASCII set), plus the
 * keyword operators that are commutative and useful in an EXCLUDE
 * constraint (`AND`, `OR` are deliberately omitted; they aren't
 * comparison operators). One-to-four-character runs are accepted;
 * longer chains are almost always either typos or smuggled-in
 * statement breaks.
 *
 * Common operators this admits: `=`, `<`, `>`, `<=`, `>=`, `<>`, `!=`,
 * `&&` (range overlap), `<<`, `>>`, `&<`, `&>`, `<<=`, `>>=`, `?`,
 * `@>`, `<@`, `~`, `~*`, `!~`, `!~*`, `||`, `<->`, `->`, `->>`, `#>`,
 * `#>>`.
 */
const SAFE_OPERATOR_RE = /^[+\-*/<>=~!@#%^&|?`]{1,4}$/

export function validateOperator(operator: string): void {
  if (!SAFE_OPERATOR_RE.test(operator)) {
    throw new SecurityError(
      `Unsafe SQL operator: "${operator}". Operators must be 1-4 punctuation characters.`,
    )
  }
}
