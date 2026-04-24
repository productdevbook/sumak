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
/**
 * Per-call options shared by {@link Driver.query} and
 * {@link Driver.execute}. Kept open so follow-ups (per-query timeout,
 * prepared-statement hints) can land additively without renaming.
 */
export interface DriverCallOptions {
  /**
   * Abort signal. When the signal fires mid-flight the driver should
   * attempt to cancel the in-progress statement — the exact mechanism
   * depends on the wire protocol (PG has a Cancel message; mysql2 has
   * `connection.destroy()` as the last resort; better-sqlite3 is
   * synchronous so the signal is checked pre-call only). Drivers that
   * can't truly cancel should still reject with `AbortError` when the
   * signal is already aborted at call time.
   */
  readonly signal?: AbortSignal
}

export interface Driver {
  /**
   * Run a statement and return every row. Used for SELECT, and for
   * INSERT/UPDATE/DELETE when `RETURNING` was requested.
   */
  query(sql: string, params: readonly unknown[], options?: DriverCallOptions): Promise<Row[]>

  /**
   * Run a statement without fetching rows. Used for plain
   * INSERT/UPDATE/DELETE (no RETURNING), DDL, TCL.
   */
  execute(
    sql: string,
    params: readonly unknown[],
    options?: DriverCallOptions,
  ): Promise<ExecuteResult>

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
   *
   * If an `AbortSignal` fires while the transaction is open, sumak
   * aborts the in-flight statement (driver-permitting) and calls
   * ROLLBACK. The `fn` reject propagates to the caller.
   */
  transaction?<T>(fn: (tx: Driver) => Promise<T>, options?: DriverCallOptions): Promise<T>

  /**
   * Optional: closes the driver's underlying connection / pool. sumak
   * never calls this — it's here so `Driver` can describe the full
   * lifecycle for user code that owns the driver.
   */
  close?(): Promise<void>
}

/**
 * A thrown `DOMException` with `name: "AbortError"`. sumak surfaces
 * this when a query is cancelled via the caller's AbortSignal. Drivers
 * that have their own cancellation error type may reject with it
 * instead; callers should match on `err.name === "AbortError"` for
 * cross-driver portability.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

/**
 * Throw an `AbortError` matching the shape of WHATWG's `DOMException`
 * with `name: "AbortError"`. Used by driver adapters to reject when
 * the caller's signal is already aborted at call time.
 */
export class AbortError extends Error {
  constructor(message = "The operation was aborted.") {
    super(message)
    this.name = "AbortError"
  }
}

/**
 * Wrap a driver's in-flight Promise so it rejects with
 * {@link AbortError} the moment the caller's signal fires. If the
 * signal is already aborted at call time, throws synchronously-ish
 * (after one microtask). Drivers with native cancellation layers
 * (mysql2's `conn.destroy()`, mssql's `request.cancel()`) should
 * invoke those from `onAbort` so the server releases locks / open
 * cursors; this helper is a last-resort watchdog that makes
 * cancellation observable to the caller even when the driver has no
 * native path.
 */
export async function withSignal<T>(
  signal: AbortSignal | undefined,
  task: Promise<T>,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return task
  if (signal.aborted) {
    onAbort?.()
    throw new AbortError()
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      try {
        onAbort?.()
      } finally {
        reject(new AbortError())
      }
    }
    signal.addEventListener("abort", handleAbort, { once: true })
    task.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener("abort", handleAbort)
        reject(err)
      },
    )
  })
}

/**
 * Convenience — the compiled-query shape a driver consumes. sumak
 * builders produce `CompiledQuery` via `.toSQL()`; the driver layer
 * unpacks it into (sql, params) for the `Driver` call.
 */
export type { CompiledQuery }

// ── Observability — onQuery hook ──────────────────────────────────────

/**
 * The three phases every sumak execute path surfaces to its
 * `onQuery` observer. Logging, tracing, and metrics wrappers subscribe
 * to the lifecycle without having to wrap every builder call
 * individually.
 *
 * - `start` fires right before the driver call is dispatched.
 * - `end` fires on resolve with the wall-clock duration and, for
 *   `query` calls, the number of rows returned.
 * - `error` fires on reject with the duration and the thrown value.
 *
 * `kind` distinguishes the three call modes the execute layer makes:
 * row-returning queries, non-returning executes, and transactional
 * BEGIN/COMMIT/ROLLBACK. Transactions additionally set `txPhase` so
 * an observer can correlate a COMMIT event with the BEGIN that
 * started it.
 */
export type QueryEventKind = "query" | "execute" | "transaction"

export interface QueryEventBase {
  readonly kind: QueryEventKind
  readonly sql: string
  readonly params: readonly unknown[]
  /**
   * Optional correlation id set to a monotonic integer per
   * `onQuery({ phase: "start" })`. The matching `end` / `error` event
   * carries the same id so observers can build spans without racing
   * on (sql, params) identity. Transactions use a single id across
   * BEGIN / COMMIT / ROLLBACK so the correlation holds for the whole
   * scope.
   */
  readonly id: number
  /**
   * When `kind === "transaction"`, tags the transactional boundary
   * event: `"begin"` on the BEGIN dispatch, `"commit"` on success,
   * `"rollback"` on a thrown error or abort. Statements run inside
   * the transaction remain `kind: "query" | "execute"`.
   */
  readonly txPhase?: "begin" | "commit" | "rollback"
}

export interface QueryStartEvent extends QueryEventBase {
  readonly phase: "start"
}

export interface QueryEndEvent extends QueryEventBase {
  readonly phase: "end"
  readonly durationMs: number
  /** Row count returned by `driver.query`. Undefined for `execute` / transaction events. */
  readonly rowCount?: number
  /** Rows affected reported by `driver.execute`. Undefined for `query` / transaction events. */
  readonly affected?: number
}

export interface QueryErrorEvent extends QueryEventBase {
  readonly phase: "error"
  readonly durationMs: number
  readonly error: unknown
}

export type QueryEvent = QueryStartEvent | QueryEndEvent | QueryErrorEvent

/**
 * Listener contract for `SumakConfig.onQuery`. Synchronous by design —
 * sumak never awaits it — so a slow observer doesn't become part of
 * the critical path. Observers that need async work (network export,
 * disk logging) should buffer in the handler and flush on their own
 * schedule. Thrown errors from the listener are swallowed so an
 * observability bug never takes down a query.
 */
export type OnQueryListener = (event: QueryEvent) => void
