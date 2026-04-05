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
 * Validates that a CAST data type is safe.
 * Allows standard SQL types including those with parameters like VARCHAR(255).
 */
const SAFE_DATA_TYPE_RE = /^[A-Za-z][A-Za-z0-9_ ]*(?:\([0-9, ]*\))?(?:\[\])?$/

export function validateDataType(dataType: string): void {
  if (!SAFE_DATA_TYPE_RE.test(dataType)) {
    throw new SecurityError(
      `Unsafe CAST data type: "${dataType}". Data types must be standard SQL type identifiers.`,
    )
  }
}
