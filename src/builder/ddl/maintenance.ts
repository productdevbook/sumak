import type { AnalyzeNode, ReindexNode, VacuumNode } from "../../ast/ddl-nodes.ts"

/**
 * Immutable builder for {@link VacuumNode} — PostgreSQL `VACUUM`.
 *
 * `VACUUM` reclaims storage from dead tuples and (with `ANALYZE`) refreshes
 * the planner statistics in a single pass. Per-table form is the
 * production-friendly default; the bare statement (no table list) runs
 * against every table in the current database and is heavy.
 *
 * Quick reference:
 *
 *  - `.table(name)` / `.tables(name, ...)` — restrict to a specific
 *    list of tables. Without any, the emitted SQL is database-wide.
 *  - `.full()` — `FULL` form. Rewrites the table on disk and takes an
 *    ACCESS EXCLUSIVE lock; never run on a hot table mid-traffic.
 *  - `.freeze()` — `FREEZE`. Aggressively freezes tuples.
 *  - `.verbose()` — `VERBOSE`. Prints progress to the server log.
 *  - `.analyze()` — `ANALYZE`. Refreshes stats in the same pass.
 *  - `.skipLocked()` — `SKIP_LOCKED` (PG 12+). Skips tables it can't
 *    immediately lock — useful inside time-bounded maintenance windows.
 *  - `.truncate(value = true)` — `TRUNCATE`. Defaults to true in PG;
 *    pass `false` to keep trailing empty pages on disk.
 *
 * The builder targets the modern `(option, option, ...)` option-list
 * syntax (PG 9.0+). Combinations are emitted in a stable order so call
 * sites with the same options serialise to the same SQL string.
 *
 * ```ts
 * vacuum().build()
 *   // VACUUM
 *
 * vacuum().table("users").analyze().build()
 *   // VACUUM (ANALYZE) "users"
 *
 * vacuum().tables("users", "orders").full().verbose().build()
 *   // VACUUM (FULL, VERBOSE) "users", "orders"
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL at print time — each has its own
 * surface for the same goal (MSSQL: `DBCC SHRINKDATABASE`; MySQL:
 * `OPTIMIZE TABLE`; SQLite: bare `VACUUM`).
 */
export class VacuumBuilder {
  private readonly node: VacuumNode

  constructor(node?: VacuumNode) {
    this.node = node ?? { type: "vacuum" }
  }

  private clone(patch: Partial<VacuumNode>): VacuumBuilder {
    return new VacuumBuilder({ ...this.node, ...patch })
  }

  /** Restrict the VACUUM to a single table. Replaces any previous list. */
  table(name: string): VacuumBuilder {
    return this.clone({ tables: [name] })
  }

  /** Restrict to a list of tables — comma-joined in the emitted SQL. */
  tables(...names: string[]): VacuumBuilder {
    return this.clone({ tables: names })
  }

  full(): VacuumBuilder {
    return this.clone({ full: true })
  }

  freeze(): VacuumBuilder {
    return this.clone({ freeze: true })
  }

  verbose(): VacuumBuilder {
    return this.clone({ verbose: true })
  }

  analyze(): VacuumBuilder {
    return this.clone({ analyze: true })
  }

  skipLocked(): VacuumBuilder {
    return this.clone({ skipLocked: true })
  }

  /**
   * `TRUNCATE` option — defaults to true (PG default). Pass `false`
   * to emit `TRUNCATE FALSE` and skip the trailing-empty-page truncate
   * step (PG 12+).
   */
  truncate(value = true): VacuumBuilder {
    return this.clone({ truncate: value })
  }

  build(): VacuumNode {
    return { ...this.node, tables: this.node.tables ? [...this.node.tables] : undefined }
  }
}

/**
 * Factory for {@link VacuumBuilder}. Returns a fresh builder with no
 * options set — call `.build()` directly for the bare `VACUUM` form.
 */
export function vacuum(): VacuumBuilder {
  return new VacuumBuilder()
}

/**
 * Immutable builder for {@link AnalyzeNode} — PostgreSQL `ANALYZE`.
 *
 * Refreshes planner statistics without reclaiming storage. The shape
 * mirrors `VACUUM` but with the much smaller option set PG accepts on
 * `ANALYZE` directly:
 *
 *  - `.table(name)` / `.tables(name, ...)` — restrict to specific tables.
 *  - `.verbose()` — `VERBOSE`.
 *  - `.skipLocked()` — `SKIP_LOCKED` (PG 12+).
 *
 * ```ts
 * analyze().build()
 *   // ANALYZE
 *
 * analyze().table("users").build()
 *   // ANALYZE "users"
 *
 * analyze().tables("users", "orders").verbose().build()
 *   // ANALYZE (VERBOSE) "users", "orders"
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL — each has a different surface.
 * (MySQL `ANALYZE TABLE` differs in grammar; SQLite `ANALYZE` accepts
 * a single object name only; MSSQL uses `UPDATE STATISTICS`.)
 */
export class AnalyzeBuilder {
  private readonly node: AnalyzeNode

  constructor(node?: AnalyzeNode) {
    this.node = node ?? { type: "analyze" }
  }

  private clone(patch: Partial<AnalyzeNode>): AnalyzeBuilder {
    return new AnalyzeBuilder({ ...this.node, ...patch })
  }

  table(name: string): AnalyzeBuilder {
    return this.clone({ tables: [name] })
  }

  tables(...names: string[]): AnalyzeBuilder {
    return this.clone({ tables: names })
  }

  verbose(): AnalyzeBuilder {
    return this.clone({ verbose: true })
  }

  skipLocked(): AnalyzeBuilder {
    return this.clone({ skipLocked: true })
  }

  build(): AnalyzeNode {
    return { ...this.node, tables: this.node.tables ? [...this.node.tables] : undefined }
  }
}

/**
 * Factory for {@link AnalyzeBuilder}. Bare `ANALYZE` (database-wide) is
 * the default; chain `.table(...)` to scope it.
 */
export function analyze(): AnalyzeBuilder {
  return new AnalyzeBuilder()
}

/**
 * Immutable builder for {@link ReindexNode} — PostgreSQL `REINDEX`.
 *
 * Rebuilds one or more indexes. The grammar pairs a *target keyword*
 * (`INDEX` / `TABLE` / `SCHEMA` / `DATABASE` / `SYSTEM`) with a name —
 * the builder constructor takes both. `CONCURRENTLY` (PG 12+) does the
 * rebuild without blocking writes; it requires twice the disk space and
 * can't run inside a transaction.
 *
 * ```ts
 * reindex("INDEX", "users_email_idx").build()
 *   // REINDEX INDEX "users_email_idx"
 *
 * reindex("TABLE", "users").concurrently().build()
 *   // REINDEX TABLE CONCURRENTLY "users"
 *
 * reindex("DATABASE", "shop").verbose().build()
 *   // REINDEX (VERBOSE) DATABASE "shop"
 * ```
 *
 * Refused on every non-PG dialect — MSSQL uses `ALTER INDEX … REBUILD`,
 * MySQL uses `OPTIMIZE TABLE` / `ALTER TABLE … FORCE`, SQLite uses the
 * option-less `REINDEX [name]` shape. Each needs a dedicated AST node
 * to express cleanly.
 */
export class ReindexBuilder {
  private readonly node: ReindexNode

  constructor(target: ReindexNode["target"], name: string)
  constructor(node: ReindexNode)
  constructor(targetOrNode: ReindexNode["target"] | ReindexNode, name?: string) {
    if (typeof targetOrNode === "string") {
      this.node = {
        type: "reindex",
        target: targetOrNode,
        name: name!,
      }
    } else {
      this.node = targetOrNode
    }
  }

  private clone(patch: Partial<ReindexNode>): ReindexBuilder {
    return new ReindexBuilder({ ...this.node, ...patch })
  }

  /** Replace the target keyword (INDEX / TABLE / SCHEMA / DATABASE / SYSTEM). */
  target(target: ReindexNode["target"]): ReindexBuilder {
    return this.clone({ target })
  }

  /** Replace the target object name. */
  name(name: string): ReindexBuilder {
    return this.clone({ name })
  }

  concurrently(): ReindexBuilder {
    return this.clone({ concurrently: true })
  }

  verbose(): ReindexBuilder {
    return this.clone({ verbose: true })
  }

  build(): ReindexNode {
    return { ...this.node }
  }
}

/**
 * Factory for {@link ReindexBuilder}. Both arguments are required —
 * REINDEX has no meaningful "bare" form (`REINDEX` alone is a parse
 * error on every PG version).
 *
 * ```ts
 * reindex("TABLE", "users").build()
 *   // REINDEX TABLE "users"
 * ```
 */
export function reindex(target: ReindexNode["target"], name: string): ReindexBuilder {
  return new ReindexBuilder(target, name)
}
