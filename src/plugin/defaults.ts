import { param } from "../ast/expression.ts"
import type { ASTNode, ExpressionNode, InsertNode } from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * A thunk that produces a column's default value at INSERT time. The
 * thunk is called once per row that's missing the column, so it can
 * close over per-request state (current user, request id, generated
 * uuid, …) and return a fresh value for each invocation.
 *
 * Return `null` to signal "no default applies, fall through to whatever
 * DB-side default the column has". This is distinct from the thunk
 * wanting to literally write `NULL` into the column — there is no
 * supported escape for that case (callers who actually want `NULL`
 * should pass it in `values({...})` themselves).
 */
export type DefaultThunk<T = unknown> = () => T | null

/** Per-table column→thunk map. Keys are column names. */
export type TableDefaults = Readonly<Record<string, DefaultThunk>>

/**
 * Top-level config: `{ [table]: { [column]: thunk } }`.
 *
 * Tables not present in the config are pass-through. Columns the user
 * already supplied in `values({...})` / `valuesMany([...])` are left
 * alone — the thunk is only consulted when the column is *missing*
 * from the INSERT's column list.
 */
export type DefaultsConfig = Readonly<Record<string, TableDefaults>>

/**
 * Plugin that auto-injects default values for INSERT columns the user
 * omitted. Each configured column gets a thunk; the thunk runs once
 * per row that doesn't already include the column, and its return
 * value is appended to the row as a parameterised expression.
 *
 * The plugin sits one level more generic than {@link AuditTimestampPlugin}:
 * audit-timestamp knows about `created_at` / `updated_at` /
 * `created_by` / `updated_by`; `defaults` is "any column, any value
 * provider". Common patterns:
 *
 * - Inject `tenantId` from request context (without taking the strict
 *   filtering behaviour of {@link MultiTenantPlugin}).
 * - Inject `createdBy` / `updatedBy` from the current user, where the
 *   column names don't match audit-timestamp's defaults.
 * - Generate UUIDs client-side, before the row hits the DB.
 * - Conditional defaults that depend on runtime state and may opt out
 *   on some calls by returning `null`.
 *
 * ```ts
 * import { defaults } from "sumak"
 *
 * const db = sumak({
 *   dialect: pgDialect(),
 *   tables: { users, posts },
 *   plugins: [
 *     defaults({
 *       users: {
 *         tenantId: () => requestContext().tenantId,
 *         createdBy: () => currentUserId(),
 *       },
 *       posts: {
 *         authorId: () => currentUserId(),
 *         tenantId: () => requestContext().tenantId,
 *       },
 *     }),
 *   ],
 * })
 *
 * // User omits tenantId / createdBy — plugin injects.
 * db.insertInto("users").values({ name: "Alice" }).toSQL()
 * // INSERT INTO "users" ("name", "tenantId", "createdBy") VALUES ($1, $2, $3)
 * // params: ["Alice", <from-context>, <from-user>]
 *
 * // Explicit values are respected — thunk is *not* called.
 * db.insertInto("users").values({ name: "Bob", tenantId: 99 }).toSQL()
 * // INSERT INTO "users" ("name", "tenantId", "createdBy") VALUES ($1, $2, $3)
 * // params: ["Bob", 99, <from-user>]
 * ```
 *
 * Behaviour rules:
 *
 * - **INSERT-only** for the first cut. UPDATE/DELETE/MERGE pass through
 *   untouched — defaults are insertion-time stamps, not edit-time
 *   rewrites. (`updatedBy` / `updatedAt` style stamping is what
 *   {@link AuditTimestampPlugin} is for.)
 * - **Multi-row inserts**: each row gets its own thunk call. A thunk
 *   that returns `null` for one row but a value for another is
 *   supported — the column is added to the INSERT column list as long
 *   as at least one row in the batch needs it (Postgres requires the
 *   column count to match across rows). Rows that wanted `null` get a
 *   parameterised `NULL`; rows that supplied their own value keep it.
 * - **Null thunk return**: skip injection for that row. If *every* row
 *   skips, the column is not added at all and the SQL stays as the
 *   user wrote it.
 * - **No SELECT/UPDATE/DELETE side-effects**: the plugin only fires on
 *   `InsertNode`. INSERT … SELECT (with `source` set, no `values`) is
 *   also untouched — we can't append default columns to a sub-SELECT's
 *   projection without restructuring the source query.
 */
export function defaults(config: DefaultsConfig): SumakPlugin {
  // Pre-build a Map<table, Map<column, thunk>> for O(1) lookup. The
  // user's config keys can be insertion-ordered objects with thousands
  // of entries; we don't want to re-iterate them per query.
  const tables = new Map<string, Map<string, DefaultThunk>>()
  for (const [table, cols] of Object.entries(config)) {
    const m = new Map<string, DefaultThunk>()
    for (const [col, thunk] of Object.entries(cols)) {
      m.set(col, thunk)
    }
    if (m.size > 0) tables.set(table, m)
  }

  /**
   * Inject defaults into a single-batch INSERT.
   *
   * Algorithm:
   *  1. Bail out if the target table isn't configured, or if there's
   *     no row data to operate on (INSERT … DEFAULT VALUES, INSERT …
   *     SELECT, empty `valuesMany`).
   *  2. For each configured column not already in `node.columns`,
   *     evaluate its thunk against every row. Track per-row results.
   *  3. If *any* row got a non-null value, append the column once to
   *     the INSERT column list and a `ParamNode` to each row at the
   *     matching position. Rows whose thunk returned `null` still
   *     need a placeholder (PG requires consistent column count
   *     across the tuple list) — they get a `ParamNode` wrapping
   *     JS `null`, which prints as a `$N` placeholder bound to `null`.
   *  4. If *every* row's thunk returned `null`, leave the column out
   *     entirely — the user's original INSERT is preserved.
   */
  function transformInsert(node: InsertNode): InsertNode {
    const cols = tables.get(node.table.name)
    if (!cols) return node
    // INSERT … SELECT or INSERT … DEFAULT VALUES — no row tuples to
    // augment. We don't try to rewrite the source SELECT; the
    // contract is "fill in missing values({}) keys".
    if (node.values.length === 0) return node

    // Configured columns the user *didn't* supply. Order is stable —
    // we iterate the Map in insertion order, which matches the order
    // the user wrote the config object — so the generated SQL has a
    // predictable column layout.
    const missing: { column: string; thunk: DefaultThunk }[] = []
    for (const [column, thunk] of cols) {
      if (!node.columns.includes(column)) missing.push({ column, thunk })
    }
    if (missing.length === 0) return node

    // Compute per-row thunk results up-front. For a multi-row batch
    // the thunk fires N times per missing column. We keep a parallel
    // array shaped [rowIndex][missingIndex] of the resolved values so
    // we can decide at the end whether the column survives the
    // "every row returned null" check.
    const resolved: (unknown | null)[][] = node.values.map(() => [])
    const columnKept: boolean[] = []
    for (let mi = 0; mi < missing.length; mi++) {
      const { thunk } = missing[mi]!
      let anyNonNull = false
      for (let ri = 0; ri < node.values.length; ri++) {
        const v = thunk()
        resolved[ri]!.push(v)
        if (v !== null) anyNonNull = true
      }
      columnKept.push(anyNonNull)
    }

    const keptCount = columnKept.filter(Boolean).length
    if (keptCount === 0) return node

    // Build the new column list and per-row value extensions, keeping
    // only the columns that had at least one non-null contribution.
    const extraCols: string[] = []
    for (let mi = 0; mi < missing.length; mi++) {
      if (columnKept[mi]) extraCols.push(missing[mi]!.column)
    }

    const values = node.values.map((row, ri) => {
      const extra: ExpressionNode[] = []
      for (let mi = 0; mi < missing.length; mi++) {
        if (!columnKept[mi]) continue
        // `null` thunk result for this row is materialised as a
        // ParamNode wrapping `null` so the column-count contract
        // across rows stays intact. The DB sees an explicit NULL
        // for this row; if the column has a DB-side DEFAULT, the
        // user should omit the row's INSERT-time default (return
        // `null` for *all* rows) so the column is dropped entirely.
        extra.push(param(0, resolved[ri]![mi]))
      }
      return [...row, ...extra]
    })

    return { ...node, columns: [...node.columns, ...extraCols], values }
  }

  return {
    name: "defaults",
    transformNode(node: ASTNode): ASTNode {
      if (node.type === "insert") return transformInsert(node)
      return node
    },
  }
}
