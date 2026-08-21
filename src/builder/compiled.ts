import type { ASTNode } from "../ast/nodes.ts"
import type { Printer } from "../printer/types.ts"
import type { CompiledQuery } from "../types.ts"

/**
 * A placeholder marker in the AST.
 * Used by compiled queries to mark positions where runtime values will be injected.
 *
 * ```ts
 * const findUser = db.selectFrom("users")
 *   .select("id", "name")
 *   .where(({ id }) => id.eq(placeholder("userId")))
 *   .toCompiled()
 *
 * // Runtime — no AST walk, just fills params:
 * findUser({ userId: 42 })
 * // → { sql: 'SELECT "id", "name" FROM "users" WHERE "id" = $1', params: [42] }
 * ```
 */
export interface PlaceholderNode {
  type: "param"
  index: number
  value: PlaceholderMarker
}

const PLACEHOLDER_BRAND: unique symbol = Symbol.for("sumak.placeholder") as any

export interface PlaceholderMarker {
  readonly [PLACEHOLDER_BRAND]: true
  readonly name: string
}

/**
 * Create a named placeholder for compiled queries.
 *
 * ```ts
 * import { placeholder } from "sumak"
 *
 * const q = db.selectFrom("users")
 *   .where(({ id }) => id.eq(placeholder("id")))
 *   .toCompiled()
 *
 * q({ id: 1 })  // { sql: '...', params: [1] }
 * q({ id: 99 }) // { sql: '...', params: [99] } — same SQL, different params
 * ```
 */
export function placeholder(name: string): PlaceholderMarker {
  return { [PLACEHOLDER_BRAND]: true as const, name }
}

export function isPlaceholder(value: unknown): value is PlaceholderMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    PLACEHOLDER_BRAND in value &&
    (value as any)[PLACEHOLDER_BRAND] === true
  )
}

/**
 * A compiled query: pre-baked SQL with placeholder slots.
 * Call it with a params object to fill the slots — no AST traversal at runtime.
 *
 * This is partial evaluation: the SQL string is computed once at setup time,
 * and only parameter values are substituted at call time.
 */
export interface CompiledQueryFn<P extends Record<string, unknown>> {
  (params: P): CompiledQuery
  /** The pre-baked SQL string (for inspection/debugging). */
  readonly sql: string
  /** The original AST node (for further optimization). */
  readonly node: ASTNode
}

/**
 * Compile an AST node into a reusable query function.
 *
 * Walks the AST once, generates SQL, and records the positions of
 * placeholder params. Subsequent calls only substitute values.
 */
export function compileQuery<P extends Record<string, unknown>>(
  node: ASTNode,
  printer: Printer,
  compileFn?: (node: ASTNode) => CompiledQuery,
): CompiledQueryFn<P> {
  // Use full pipeline if available, otherwise just printer
  const compiled = compileFn ? compileFn(node) : printer.print(node)

  // Find placeholder positions in the params array
  const slots: { index: number; name: string }[] = []
  const baseParams: unknown[] = []

  for (let i = 0; i < compiled.params.length; i++) {
    const p = compiled.params[i]
    if (isPlaceholder(p)) {
      slots.push({ index: i, name: p.name })
      baseParams.push(undefined) // will be filled at call time
    } else {
      baseParams.push(p)
    }
  }

  const sql = compiled.sql
  // Values reaching a placeholder never passed the printer, so the conversion
  // it does on the way past has to happen here — a `bigint` handed to `pg` raw
  // is rejected by the driver.
  const coerce = printer.coerceParam
  const fn = bind<P>(sql, slots, baseParams, coerce)

  Object.defineProperty(fn, "sql", { value: sql, writable: false })
  Object.defineProperty(fn, "node", { value: node, writable: false })

  return fn
}

/**
 * Build the function that fills the placeholders.
 *
 * Fixed shapes for the arities that cover almost every query: an array literal
 * is the cheapest thing that produces a fresh array, and a query executed in a
 * request loop runs this and nothing else.
 */
function bind<P extends Record<string, unknown>>(
  sql: string,
  slots: { index: number; name: string }[],
  baseParams: unknown[],
  coerce: (value: unknown) => unknown,
): CompiledQueryFn<P> {
  if (slots.length === 0) {
    return function execute(): CompiledQuery {
      return { sql, params: baseParams }
    } as unknown as CompiledQueryFn<P>
  }

  if (slots.length === baseParams.length) {
    const names = slots.map((slot) => slot.name)
    const [a, b, c, d] = names
    switch (names.length) {
      case 1:
        return function execute(params: P): CompiledQuery {
          return { sql, params: [coerce(params[a as string])] }
        } as unknown as CompiledQueryFn<P>
      case 2:
        return function execute(params: P): CompiledQuery {
          return { sql, params: [coerce(params[a as string]), coerce(params[b as string])] }
        } as unknown as CompiledQueryFn<P>
      case 3:
        return function execute(params: P): CompiledQuery {
          return {
            sql,
            params: [
              coerce(params[a as string]),
              coerce(params[b as string]),
              coerce(params[c as string]),
            ],
          }
        } as unknown as CompiledQueryFn<P>
      case 4:
        return function execute(params: P): CompiledQuery {
          return {
            sql,
            params: [
              coerce(params[a as string]),
              coerce(params[b as string]),
              coerce(params[c as string]),
              coerce(params[d as string]),
            ],
          }
        } as unknown as CompiledQueryFn<P>
      default:
        return function execute(params: P): CompiledQuery {
          const filled: unknown[] = []
          for (const name of names) filled.push(coerce(params[name]))
          return { sql, params: filled }
        } as unknown as CompiledQueryFn<P>
    }
  }

  return function execute(params: P): CompiledQuery {
    const filled = baseParams.slice()
    for (const slot of slots) {
      filled[slot.index] = coerce(params[slot.name])
    }
    return { sql, params: filled }
  } as unknown as CompiledQueryFn<P>
}

/**
 * Collect all placeholder names from an AST node.
 * Useful for type inference and validation.
 */
export function collectPlaceholders(node: ASTNode): string[] {
  const names: string[] = []
  walkForPlaceholders(node, names)
  return [...new Set(names)]
}

function walkForPlaceholders(node: unknown, names: string[]): void {
  if (node === null || node === undefined || typeof node !== "object") return

  if (isPlaceholder(node)) {
    names.push(node.name)
    return
  }

  // Check if it's a param node with a placeholder value
  const n = node as Record<string, unknown>
  if (n.type === "param" && isPlaceholder(n.value)) {
    names.push((n.value as PlaceholderMarker).name)
    return
  }

  // Recurse into arrays and objects
  if (Array.isArray(node)) {
    for (const item of node) walkForPlaceholders(item, names)
    return
  }

  for (const value of Object.values(n)) {
    walkForPlaceholders(value, names)
  }
}
