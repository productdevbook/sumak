import { raw as rawNode } from "../ast/expression.ts"
import type { RawNode } from "../ast/nodes.ts"

/**
 * Unsafe raw SQL node — escape hatch for arbitrary SQL.
 *
 * **WARNING:** Never pass user-controlled input as the SQL string.
 * This bypasses all security validation and can lead to SQL injection.
 */
export function unsafeRaw(sql: string, params: unknown[] = []): RawNode {
  return rawNode(sql, params)
}
