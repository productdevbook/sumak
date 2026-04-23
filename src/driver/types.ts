import type { CompiledQuery } from "../types.ts"

/**
 * A single row returned from the database. Shape depends on the query's
 * column list — sumak's builder layer tracks this statically, but the
 * driver interface is intentionally untyped (drivers don't know about
 * sumak's type parameters).
 */
export type Row = Record<string, unknown>

/**
 * Result of an `execute` (non-SELECT) call.
 */
export interface ExecuteResult {
  /** Rows affected by the statement (INSERT/UPDATE/DELETE). */
  affected: number
}

/**
 * Driver interface — the single contract between sumak and an
 * underlying database client (pg, mysql2, better-sqlite3, tedious, …).
 *
 * sumak never imports a driver; user code provides this interface. The
 * sumak repository may ship thin convenience adapters, but they remain
 * optional — implementing `Driver` directly is 5–15 lines of glue.
 *
 * ```ts
 * // Example: a minimal node-postgres adapter (no dep on pg in sumak).
 * import { Pool } from "pg"
 * import type { Driver } from "sumak"
 *
 * export function pgDriver(pool: Pool): Driver {
 *   return {
 *     async query(sql, params) {
 *       const r = await pool.query(sql, [...params])
 *       return r.rows
 *     },
 *     async execute(sql, params) {
 *       const r = await pool.query(sql, [...params])
 *       return { affected: r.rowCount ?? 0 }
 *     },
 *   }
 * }
 * ```
 *
 * **Error model.** Drivers are expected to throw on SQL / connection
 * errors. sumak does not wrap driver errors — they surface unchanged to
 * the caller so tooling like retry wrappers and connection-pool
 * instrumentation keeps working.
 */
export interface Driver {
  /**
   * Run a statement and return every row. Used for SELECT, and for
   * INSERT/UPDATE/DELETE when `RETURNING` was requested.
   */
  query(sql: string, params: readonly unknown[]): Promise<Row[]>

  /**
   * Run a statement without fetching rows. Used for plain
   * INSERT/UPDATE/DELETE (no RETURNING), DDL, TCL.
   */
  execute(sql: string, params: readonly unknown[]): Promise<ExecuteResult>

  /**
   * Optional: begin a transaction and return a scoped `Driver` whose
   * `query` and `execute` calls run inside it. If absent, sumak falls
   * back to emitting BEGIN/COMMIT/ROLLBACK as ordinary statements on
   * the parent driver — works, but may share the driver's connection
   * pool semantics (e.g. pg's auto-commit per pool.query).
   *
   * The returned function receives a scoped driver and must resolve
   * with the caller's result; sumak calls COMMIT on resolve and
   * ROLLBACK on throw.
   */
  transaction?<T>(fn: (tx: Driver) => Promise<T>): Promise<T>

  /**
   * Optional: closes the driver's underlying connection / pool. sumak
   * never calls this — it's here so `Driver` can describe the full
   * lifecycle for user code that owns the driver.
   */
  close?(): Promise<void>
}

/**
 * Convenience — the compiled-query shape a driver consumes. sumak
 * builders produce `CompiledQuery` via `.toSQL()`; the driver layer
 * unpacks it into (sql, params) for the `Driver` call.
 */
export type { CompiledQuery }
