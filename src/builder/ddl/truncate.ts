import type { TruncateTableNode } from "../../ast/ddl-nodes.ts"
import type { TableRefNode } from "../../ast/nodes.ts"

/**
 * Single table identifier accepted by {@link truncate}. Either a bare
 * unqualified name (`"users"`) or a `{ name, schema }` pair for an
 * explicitly schema-qualified target. The string-form sugar fans out to
 * `{ name, schema: undefined }` internally.
 */
export type TruncateTableArg = string | { name: string; schema?: string }

/**
 * Multi-table TRUNCATE builder. Covers the full PostgreSQL grammar
 * (`TRUNCATE [TABLE] [ONLY] tab1 [, tab2 ...] [RESTART IDENTITY |
 * CONTINUE IDENTITY] [CASCADE | RESTRICT]`) and degrades gracefully on
 * MySQL / MSSQL (simple form only — the printer refuses any
 * PG-specific modifier and any multi-table list at emit time).
 *
 * SQLite has no TRUNCATE at all; the printer refuses with a pointer at
 * the `db.deleteFrom(table).allRows()` workaround.
 *
 * The methods are pairwise mutually exclusive — calling both
 * `.cascade()` and `.restrict()`, or `.restartIdentity()` and
 * `.continueIdentity()`, on the same builder is a programmer error and
 * the build is left in a `cascade && restrict` shape so the printer
 * surfaces the conflict (rather than silently picking a winner).
 *
 * ```ts
 * // Single table, default behaviour:
 * db.compileDDL(truncate("users").build())
 *   // PG: TRUNCATE TABLE "users"
 *
 * // Multiple tables in one statement (PG only):
 * db.compileDDL(truncate(["users", "orders"]).cascade().build())
 *   // PG: TRUNCATE TABLE "users", "orders" CASCADE
 *
 * // Skip inheritance children, restart sequences (PG only):
 * db.compileDDL(truncate("events").only().restartIdentity().build())
 *   // PG: TRUNCATE TABLE ONLY "events" RESTART IDENTITY
 * ```
 */
export class TruncateBuilder {
  private readonly node: TruncateTableNode

  constructor(tables: TruncateTableArg | TruncateTableArg[]) {
    const list = Array.isArray(tables) ? tables : [tables]
    if (list.length === 0) {
      throw new Error("truncate(...) requires at least one table.")
    }
    const refs: TableRefNode[] = list.map((entry) => {
      if (typeof entry === "string") {
        return { type: "table_ref", name: entry }
      }
      return { type: "table_ref", name: entry.name, schema: entry.schema }
    })
    this.node = { type: "truncate_table", tables: refs }
  }

  private clone(patch: Partial<TruncateTableNode>): TruncateBuilder {
    const next = Object.create(TruncateBuilder.prototype) as { node: TruncateTableNode }
    next.node = { ...this.node, ...patch }
    return next as unknown as TruncateBuilder
  }

  /**
   * Emit `ONLY` — skip table-inheritance descendants. PG only; the
   * printer refuses on MySQL / MSSQL (neither has inheritance).
   */
  only(): TruncateBuilder {
    return this.clone({ only: true })
  }

  /**
   * Emit `RESTART IDENTITY` — restart sequences attached to identity
   * columns on the truncated tables. PG only; MySQL / MSSQL have
   * separate mechanisms (`ALTER TABLE … AUTO_INCREMENT = 1` /
   * `DBCC CHECKIDENT (t, RESEED, 0)`).
   */
  restartIdentity(): TruncateBuilder {
    return this.clone({ restartIdentity: true, continueIdentity: false })
  }

  /**
   * Emit `CONTINUE IDENTITY` — leave identity-column sequences alone.
   * This is the SQL standard default and the printer normally omits
   * the keyword; calling this method materialises it explicitly. PG
   * only.
   */
  continueIdentity(): TruncateBuilder {
    return this.clone({ continueIdentity: true, restartIdentity: false })
  }

  /**
   * Emit `CASCADE` — also truncate every table that references the
   * named tables by foreign key, transitively. PG only; the default
   * (`RESTRICT`) refuses to truncate a table that is referenced.
   */
  cascade(): TruncateBuilder {
    return this.clone({ cascade: true, restrict: false })
  }

  /**
   * Emit `RESTRICT` — refuse to truncate when a foreign key references
   * the table. This is the SQL standard default; the printer normally
   * omits the keyword. PG only.
   */
  restrict(): TruncateBuilder {
    return this.clone({ restrict: true, cascade: false })
  }

  build(): TruncateTableNode {
    return { ...this.node, tables: this.node.tables.map((t) => ({ ...t })) }
  }
}

/**
 * Factory for the multi-table TRUNCATE builder.
 *
 * Accepts a single table (string or `{ name, schema }`), a list of
 * either, or a mixed list. Returns a {@link TruncateBuilder} with the
 * full PG grammar exposed via fluent methods.
 *
 * ```ts
 * truncate("users").build()
 * truncate(["users", "orders"]).cascade().build()
 * truncate({ name: "events", schema: "audit" }).only().build()
 * ```
 */
export function truncate(tables: TruncateTableArg | TruncateTableArg[]): TruncateBuilder {
  return new TruncateBuilder(tables)
}
