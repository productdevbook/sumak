import type { ColumnRefNode } from "../ast/nodes.ts"

/**
 * Parse a column identifier that may carry a table qualifier.
 *
 * - `"id"` → `{ column: "id" }`
 * - `"posts.id"` → `{ column: "id", table: "posts" }`
 *
 * Without this the whole string is quoted as one name and `posts.id` reaches
 * the database as a column literally called `posts.id`, which no table has.
 *
 * Unlike {@link parseTableRef} this does not refuse quote characters: a column
 * name is taken raw here and the printer escapes it, which is what
 * `test/printer/*` pins. Only the dot is structural, and a column whose real
 * name contains one has to be built by hand.
 */
export function parseColumnRef(identifier: string): ColumnRefNode {
  const dotIndex = identifier.indexOf(".")
  if (dotIndex < 0) {
    return { type: "column_ref", column: identifier, table: undefined }
  }

  const table = identifier.slice(0, dotIndex)
  const column = identifier.slice(dotIndex + 1)
  // Anything deeper than one qualifier is ambiguous; leave it whole rather
  // than guess which part is the schema.
  if (column.includes(".")) {
    return { type: "column_ref", column: identifier, table: undefined }
  }
  if (table.length === 0 || column.length === 0) {
    throw new Error(
      `Invalid column identifier: "${identifier}" — table and column must both be non-empty.`,
    )
  }
  return { type: "column_ref", column, table }
}
