import type { ExpressionNode, RawNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { escapeStringLiteral } from "../utils/security.ts"

/**
 * Tagged template literal for raw SQL with auto-parameterization.
 *
 * Interpolated values are handled based on their type:
 * - `Expression<T>` → embedded as AST node (printed inline)
 * - Primitive values (string, number, boolean, null) → parameterized
 *
 * ```ts
 * sql`SELECT * FROM users WHERE id = ${val(1)}`
 * sql`SELECT * FROM users WHERE name = ${"Alice"}`
 * ```
 */
export function sql<T = unknown>(
  strings: TemplateStringsArray,
  ...values: (Expression<any> | string | number | boolean | null)[]
): Expression<T> {
  const sqlParts: string[] = []
  const params: unknown[] = []

  for (let i = 0; i < strings.length; i++) {
    sqlParts.push(strings[i]!)

    if (i < values.length) {
      const value = values[i]
      if (value !== null && typeof value === "object" && "node" in (value as any)) {
        // Expression<T> — inline the node's SQL representation
        // We use a placeholder that the printer will replace
        const exprNode = (value as any).node as ExpressionNode
        if (exprNode.type === "literal") {
          if (exprNode.value === null) sqlParts.push("NULL")
          else if (typeof exprNode.value === "boolean")
            sqlParts.push(exprNode.value ? "TRUE" : "FALSE")
          else if (typeof exprNode.value === "number") sqlParts.push(String(exprNode.value))
          else sqlParts.push(`'${escapeStringLiteral(String(exprNode.value))}'`)
        } else if (exprNode.type === "param") {
          params.push(exprNode.value)
          sqlParts.push(`__PARAM_${params.length - 1}__`)
        } else if (exprNode.type === "column_ref") {
          const col = exprNode.table
            ? `"${exprNode.table.replaceAll('"', '""')}"."${exprNode.column.replaceAll('"', '""')}"`
            : `"${exprNode.column.replaceAll('"', '""')}"`
          sqlParts.push(col)
        } else if (exprNode.type === "raw") {
          params.push(...exprNode.params)
          sqlParts.push(exprNode.sql)
        } else {
          // For complex expressions, embed as raw SQL fragment
          sqlParts.push("(?)")
        }
      } else {
        // Primitive value → parameterize
        params.push(value)
        sqlParts.push(`__PARAM_${params.length - 1}__`)
      }
    }
  }

  const rawSql = sqlParts.join("")
  const node: RawNode = {
    type: "raw",
    sql: rawSql,
    params,
  }
  return { node } as Expression<T>
}

/**
 * SQL identifier quoting helper for use in sql`` template.
 *
 * ```ts
 * sql`SELECT * FROM ${sql.ref("users")} WHERE ${sql.ref("id")} = ${1}`
 * ```
 */
sql.ref = function ref(name: string, table?: string): Expression<any> {
  const node: ExpressionNode = { type: "column_ref", column: name, table }
  return { node } as Expression<any>
}

/**
 * SQL table reference for use in sql`` template.
 * Escapes identifier delimiters to prevent injection.
 *
 * Note: Uses ANSI SQL double-quote escaping. For dialect-aware quoting,
 * use the builder API instead of raw sql templates.
 */
sql.table = function table(name: string, schema?: string): Expression<any> {
  const escaped = name.replaceAll('"', '""')
  const quoted = schema ? `"${schema.replaceAll('"', '""')}"."${escaped}"` : `"${escaped}"`
  const node: RawNode = { type: "raw", sql: quoted, params: [] }
  return { node } as Expression<any>
}

/**
 * Unsafe raw SQL string — no escaping.
 *
 * **WARNING:** Never pass user-controlled input. This bypasses all
 * security validation and can lead to SQL injection.
 */
sql.unsafe = function unsafeSql(str: string): Expression<any> {
  const node: RawNode = { type: "raw", sql: str, params: [] }
  return { node } as Expression<any>
}

/**
 * Literal value (not parameterized) — for constants.
 */
sql.lit = function lit(value: string | number | boolean | null): Expression<any> {
  const node: ExpressionNode = { type: "literal", value }
  return { node } as Expression<any>
}
