// ═══════════════════════════════════════════════════════════════════════════
//  sumak — security audit helpers
//
//  Opt-in dev-mode hooks around the `unsafeRawExpr` / `unsafeSqlFn`
//  escape hatches + static AST auditors for CI / production use.
// ═══════════════════════════════════════════════════════════════════════════

import type { ASTNode, ExpressionNode } from "./ast/nodes.ts"

export interface UnsafeUsageEvent {
  /** Which escape hatch was called. */
  readonly kind: "unsafeRawExpr" | "unsafeSqlFn"
  /**
   * For `unsafeRawExpr` — the SQL fragment passed in. For
   * `unsafeSqlFn` — the function name. Truncated to 200 chars so a
   * giant fragment doesn't flood the log.
   */
  readonly argument: string
  /** Call-site stack trace at the point of the unsafe call. */
  readonly stack: string
}

export type UnsafeUsageHandler = (event: UnsafeUsageEvent) => void

let handler: UnsafeUsageHandler | undefined

/**
 * Install a listener that fires every time `unsafeRawExpr` or
 * `unsafeSqlFn` runs. Pass `undefined` to clear. Useful in dev /
 * staging for tracking how much raw SQL leaks into the codebase and
 * where from — production loggers typically leave it off.
 *
 * The same behaviour fires automatically when
 * `process.env.SUMAK_WARN_UNSAFE` is set (any non-empty value):
 * sumak writes a `console.warn` with the call site and the arg.
 * Explicit handlers take precedence over the env var.
 */
export function setUnsafeWarnHandler(fn: UnsafeUsageHandler | undefined): void {
  handler = fn
}

/**
 * Fire the audit hook. Called from inside `unsafeRawExpr` /
 * `unsafeSqlFn`. Kept internal because it's an implementation detail
 * of those factories; public observers use {@link setUnsafeWarnHandler}.
 *
 * @internal
 */
export function notifyUnsafeUsage(kind: UnsafeUsageEvent["kind"], argument: string): void {
  if (!handler && !readEnv("SUMAK_WARN_UNSAFE")) return
  const trimmed = argument.length > 200 ? `${argument.slice(0, 200)}…` : argument
  const stack = captureStack()
  const event: UnsafeUsageEvent = { kind, argument: trimmed, stack }
  if (handler) {
    try {
      handler(event)
    } catch {
      // Audit handler must never take down the caller. Silence.
    }
    return
  }
  // Env-var fallback. `console.warn` so Node / browser both log it
  // without us pulling in a logger.
  // eslint-disable-next-line no-console
  console.warn(`[sumak:unsafe] ${kind}(${JSON.stringify(trimmed)})\n${stack}`)
}

function readEnv(name: string): string | undefined {
  // Guard for environments without process (browsers, workers).
  // Accessed via globalThis so this module doesn't need @types/node;
  // the structural cast is narrow enough to still light up for typos.
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process
  if (!proc || !proc.env) return undefined
  const v = proc.env[name]
  return v && v.length > 0 ? v : undefined
}

function captureStack(): string {
  const err = new Error("stack")
  const lines = (err.stack ?? "").split("\n")
  // Drop the first two frames (Error ctor + captureStack itself) so
  // the trace starts at the caller of unsafeRawExpr / unsafeSqlFn.
  return lines.slice(3).join("\n")
}

// ═══════════════════════════════════════════════════════════════════════════
//  AST auditors — static, zero-side-effect scans for use in CI.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Shape of a raw-SQL occurrence found inside an AST. `path` is a
 * human-readable breadcrumb so callers can report where in the tree
 * the raw node sits — useful for CI messages that need to point at
 * a specific predicate rather than a whole query.
 */
export interface RawOccurrence {
  readonly sql: string
  readonly path: string
}

/**
 * Walk an AST and collect every `raw` node it finds. Audit scripts
 * use this in CI to fail a build that accidentally introduced new
 * unsafeRawExpr call sites, or to count the number of escape-hatch
 * uses per service.
 *
 * Identity-preserving: never mutates the input.
 */
export function findRawNodes(root: ASTNode): RawOccurrence[] {
  const out: RawOccurrence[] = []
  walk(root, "", out)
  return out
}

function walk(node: unknown, path: string, out: RawOccurrence[]): void {
  if (node === null || typeof node !== "object") return
  const n = node as Record<string, unknown> & { type?: string }
  if (n.type === "raw" && typeof n.sql === "string") {
    out.push({ sql: n.sql, path: path || "<root>" })
    // A raw node has no meaningful child expressions to recurse into
    // — its `params` list is values, not ASTNodes. Returning early
    // keeps the report focused.
    return
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walk(node[i], `${path}[${i}]`, out)
    }
    return
  }
  for (const [key, value] of Object.entries(n)) {
    if (key === "type") continue
    walk(value, path ? `${path}.${key}` : key, out)
  }
}

/**
 * Convenience predicate for tests / CI scripts: did this expression
 * / statement contain any `raw` nodes? Equivalent to
 * `findRawNodes(node).length > 0` but returns early.
 */
export function hasRawNodes(root: ASTNode | ExpressionNode): boolean {
  return findRawNodesInner(root)
}

function findRawNodesInner(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false
  const n = node as Record<string, unknown> & { type?: string }
  if (n.type === "raw") return true
  if (Array.isArray(node)) {
    for (const v of node) if (findRawNodesInner(v)) return true
    return false
  }
  for (const v of Object.values(n)) {
    if (findRawNodesInner(v)) return true
  }
  return false
}
