import type { TableRefNode } from "../ast/nodes.ts"

/**
 * Parse a table identifier that may contain a schema prefix into a
 * TableRefNode. Accepts:
 *
 * - `"users"` → `{ name: "users" }`
 * - `"audit.logs"` → `{ name: "logs", schema: "audit" }`
 *
 * Only one level of schema nesting is supported (PostgreSQL + MySQL
 * `database.table`). Identifiers are not unquoted — if a literal dot
 * appears in a table name, pass a pre-built `TableRefNode` directly
 * instead of the dotted-string shortcut.
 */
export function parseTableRef(identifier: string, alias?: string): TableRefNode {
  const dotIndex = identifier.indexOf(".")
  if (dotIndex < 0) {
    return { type: "table_ref", name: identifier, alias }
  }
  const schema = identifier.slice(0, dotIndex)
  const name = identifier.slice(dotIndex + 1)
  // Guard against malformed input: multiple dots or empty parts.
  if (name.includes(".") || schema.length === 0 || name.length === 0) {
    return { type: "table_ref", name: identifier, alias }
  }
  return { type: "table_ref", name, schema, alias }
}
