import type { ResultContext, SumakPlugin } from "./types.ts"

/**
 * Config for {@link subjectType} — maps a table name to the subject
 * type string that authorization / GraphQL / CASL code wants to see.
 */
export interface SubjectTypeConfig {
  /**
   * Table → subject-type map. `{ messages: "Message", users: "User" }`
   * produces `row.__typename = "Message"` for every row returned from
   * `db.selectFrom("messages")` (and `.returning()` on INSERT/UPDATE/
   * DELETE into the same table).
   */
  readonly tables: Readonly<Record<string, string>>
  /**
   * Field name to write. Defaults to `__typename` — matches GraphQL
   * convention and CASL's recommended subject-detection property.
   */
  readonly field?: string
}

/**
 * Plugin that tags every row returned from a configured table with a
 * stable subject-type string, so authorization libraries like CASL
 * (or any resource-based access control) can match rules to rows
 * without the caller manually calling `as(row, "Message")`.
 *
 * ```ts
 * const db = sumak({
 *   dialect: pgDialect(),
 *   driver: pgDriver(pool),
 *   plugins: [subjectType({ tables: { messages: "Message", users: "User" } })],
 *   tables: { messages: { … }, users: { … } },
 * })
 *
 * const msg = await db.selectFrom("messages").where(({ id }) => id.eq(1)).one()
 * // msg.__typename === "Message" → CASL can now match rules that reference "Message"
 * ```
 *
 * **Scope.** The plugin stamps rows with the primary target table's
 * subject type. Multi-table JOIN rows — where a single row has
 * columns from several tables — get the FROM-table's subject type;
 * per-column origin tracking is available in the `ResultContext`
 * but most users should lift per-table rows out of a JOIN via
 * separate queries (CASL's authorization model expects one subject
 * per check anyway).
 *
 * **Interaction with plain `.toSQL()`.** This is a result-time
 * transform — it fires on `.many()` / `.one()` / `.first()` (and on
 * `Sumak.executeCompiled`), but not on `.toSQL()` (which just returns
 * SQL and never sees rows). Driverless callers who hand-execute SQL
 * must run `db.transformResult(rows, ctx)` themselves.
 */
export function subjectType(config: SubjectTypeConfig): SumakPlugin {
  const field = config.field ?? "__typename"
  const tables = config.tables
  return {
    name: "subjectType",
    transformResult(rows, ctx) {
      const target = ctx?.table
      if (!target) return rows
      const subject = tables[target]
      if (subject === undefined) return rows
      // Don't overwrite a field the user already set — the intent was
      // to enrich, not to clobber a schema column named `__typename`.
      return rows.map((r) => (field in r ? r : { ...r, [field]: subject }))
    },
  }
}

// Re-export for convenience so users writing custom enrichers can see
// the context shape without digging through plugin/types.
export type { ResultContext }
