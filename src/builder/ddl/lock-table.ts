import type { LockTableNode } from "../../ast/ddl-nodes.ts"

/**
 * Lock-mode keyword surface for {@link LockTableNode.mode}. Re-exported
 * so callers chaining off `.mode(...)` get autocomplete on the
 * spelled-out PG keywords instead of having to memorise them.
 */
export type LockMode = NonNullable<LockTableNode["mode"]>

/**
 * Immutable builder for {@link LockTableNode} — PostgreSQL `LOCK TABLE`.
 *
 * `LOCK TABLE` takes a named table-level lock inside the current
 * transaction. Eight modes map to the PG keywords (`ACCESS SHARE` …
 * `ACCESS EXCLUSIVE`) — see {@link LockTableNode} for the conflict
 * matrix. The default when no mode is given is `ACCESS EXCLUSIVE`, the
 * strictest mode; explicit shortcut methods exist for every level so
 * the typical "I just want to serialize against concurrent writes"
 * call site reads as `.share()` or `.exclusive()` rather than
 * `.mode("SHARE")`.
 *
 * `.noWait()` flips the `NOWAIT` modifier — fail immediately instead of
 * waiting when the lock can't be taken right away. The classic
 * try-lock idiom is `lockTable("foo").exclusive().noWait()` paired
 * with a caught error to detect contention.
 *
 * ```ts
 * lockTable("orders").build()
 *   // LOCK TABLE "orders"
 *
 * lockTable("orders").exclusive().noWait().build()
 *   // LOCK TABLE "orders" IN EXCLUSIVE MODE NOWAIT
 *
 * lockTable(["orders", "order_lines"]).share().only().build()
 *   // LOCK TABLE ONLY "orders", "order_lines" IN SHARE MODE
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL at print time — MySQL's
 * `LOCK TABLES name READ|WRITE` has a different grammar and
 * transaction story, MSSQL uses per-query table hints
 * (`WITH (TABLOCK)`), and SQLite has no equivalent at all.
 */
export class LockTableBuilder {
  private readonly node: LockTableNode

  constructor(tables: string | string[])
  constructor(node: LockTableNode)
  constructor(arg: string | string[] | LockTableNode) {
    if (typeof arg === "string") {
      this.node = { type: "lock_table", tables: [arg] }
    } else if (Array.isArray(arg)) {
      // Defensive copy — callers reasonably mutate the array they
      // passed in after construction. Maintenance / extension builders
      // do the same thing for symmetry.
      this.node = { type: "lock_table", tables: [...arg] }
    } else {
      this.node = arg
    }
  }

  private clone(patch: Partial<LockTableNode>): LockTableBuilder {
    return new LockTableBuilder({
      ...this.node,
      ...patch,
      // Keep the tables array independent from the caller-passed source
      // so a later `.only()` chain doesn't mutate someone else's list.
      tables: patch.tables ? [...patch.tables] : [...this.node.tables],
    })
  }

  /**
   * Emit `ONLY` to skip inheritance descendants. Applies uniformly to
   * every table in the list.
   */
  only(): LockTableBuilder {
    return this.clone({ only: true })
  }

  /**
   * Set the lock mode explicitly. Useful when the mode comes from
   * config or another runtime source; prefer the spelled-out
   * `.accessShare()` / `.exclusive()` / … shortcuts when the mode is
   * known at the call site.
   */
  mode(value: LockMode): LockTableBuilder {
    return this.clone({ mode: value })
  }

  /** `IN ACCESS SHARE MODE` — least strict; conflicts only with `ACCESS EXCLUSIVE`. */
  accessShare(): LockTableBuilder {
    return this.clone({ mode: "ACCESS SHARE" })
  }

  /** `IN ROW SHARE MODE` — implicit lock taken by `SELECT … FOR UPDATE / SHARE`. */
  rowShare(): LockTableBuilder {
    return this.clone({ mode: "ROW SHARE" })
  }

  /** `IN ROW EXCLUSIVE MODE` — implicit lock taken by `INSERT / UPDATE / DELETE`. */
  rowExclusive(): LockTableBuilder {
    return this.clone({ mode: "ROW EXCLUSIVE" })
  }

  /**
   * `IN SHARE UPDATE EXCLUSIVE MODE` — implicit lock taken by `VACUUM`
   * (without `FULL`), `ANALYZE`, `CREATE INDEX CONCURRENTLY`, …
   */
  shareUpdateExclusive(): LockTableBuilder {
    return this.clone({ mode: "SHARE UPDATE EXCLUSIVE" })
  }

  /**
   * `IN SHARE MODE` — implicit lock taken by `CREATE INDEX` without
   * `CONCURRENTLY`. Blocks writes but lets reads continue.
   */
  share(): LockTableBuilder {
    return this.clone({ mode: "SHARE" })
  }

  /** `IN SHARE ROW EXCLUSIVE MODE` — like SHARE but also self-conflicting. */
  shareRowExclusive(): LockTableBuilder {
    return this.clone({ mode: "SHARE ROW EXCLUSIVE" })
  }

  /** `IN EXCLUSIVE MODE` — blocks every other lock except `ACCESS SHARE`. */
  exclusive(): LockTableBuilder {
    return this.clone({ mode: "EXCLUSIVE" })
  }

  /**
   * `IN ACCESS EXCLUSIVE MODE` — implicit lock taken by `DROP TABLE`,
   * `TRUNCATE`, `REINDEX`, `ALTER TABLE`, `VACUUM FULL`. Blocks every
   * other lock; this is the PG default when no `IN … MODE` is given,
   * so calling this is equivalent to omitting the mode entirely (the
   * printer still emits the explicit keyword for clarity in audit
   * trails).
   */
  accessExclusive(): LockTableBuilder {
    return this.clone({ mode: "ACCESS EXCLUSIVE" })
  }

  /**
   * `NOWAIT` — fail with an error immediately if the lock can't be
   * taken, instead of waiting indefinitely. Used in try-lock idioms.
   */
  noWait(): LockTableBuilder {
    return this.clone({ noWait: true })
  }

  build(): LockTableNode {
    return { ...this.node, tables: [...this.node.tables] }
  }
}

/**
 * Factory for {@link LockTableBuilder}. Accepts either a single table
 * name or an array — PG permits a comma-separated list in a single
 * statement, so the AST and printer preserve that.
 *
 * ```ts
 * lockTable("orders").exclusive().build()
 *   // LOCK TABLE "orders" IN EXCLUSIVE MODE
 *
 * lockTable(["orders", "order_lines"]).share().build()
 *   // LOCK TABLE "orders", "order_lines" IN SHARE MODE
 * ```
 */
export function lockTable(tables: string | string[]): LockTableBuilder {
  return new LockTableBuilder(tables)
}
