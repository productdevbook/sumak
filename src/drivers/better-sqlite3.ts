import type { Driver, DriverCallOptions, ExecuteResult, Row } from "../driver/types.ts"
import { AbortError } from "../driver/types.ts"

/**
 * Minimal surface of `better-sqlite3`'s Database class that sumak uses.
 * The real package is a native module; we depend on nothing at build
 * time. The `.prepare(sql)` / `.all(params)` / `.run(params)` chain is
 * the whole API we exercise.
 */
export interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement
  exec(sql: string): void
}

export interface BetterSqlite3Statement {
  all(...params: unknown[]): Record<string, unknown>[]
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  /**
   * better-sqlite3's `.iterate(...params)` returns a synchronous
   * iterator that pulls one row at a time from the native cursor.
   * sumak's streaming adapter bridges this into an `AsyncIterable`
   * so the `for await` protocol and the `Driver.stream()` contract
   * both work.
   */
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>
}

export interface BetterSqlite3DriverOptions {
  readonly captureTransactions?: boolean
}

/**
 * Adapt a `better-sqlite3` Database to sumak's {@link Driver}.
 * better-sqlite3 is synchronous and extremely fast, so we wrap its
 * results in `Promise.resolve` rather than using `async`/await (which
 * always yields at least one microtask).
 *
 * ```ts
 * import Database from "better-sqlite3"
 * import { sumak } from "sumak"
 * import { betterSqlite3Driver } from "sumak/drivers/better-sqlite3"
 *
 * const db = new Database(":memory:")
 * const s = sumak({
 *   dialect: sqliteDialect(),
 *   driver: betterSqlite3Driver(db),
 *   tables,
 * })
 * ```
 *
 * Transactions: better-sqlite3 has its own `db.transaction(fn)` helper,
 * but it's synchronous — it rejects any `await` inside the callback. We
 * therefore don't delegate to it; sumak emits `BEGIN` / `COMMIT` /
 * `ROLLBACK` directly (or, when `captureTransactions` is true, uses
 * `BEGIN IMMEDIATE` for stricter locking).
 */
export function betterSqlite3Driver(
  db: BetterSqlite3Database,
  options: BetterSqlite3DriverOptions = {},
): Driver {
  const captureTx = options.captureTransactions ?? true

  // better-sqlite3 is synchronous; we can only honour a signal that's
  // already aborted at call time (once we're inside `.all()` / `.run()`,
  // the JS main thread is blocked until the native call returns).
  const checkSignal = (opts?: DriverCallOptions): void => {
    if (opts?.signal?.aborted) throw new AbortError()
  }

  const runQuery = (sql: string, params: readonly unknown[]): Row[] => {
    const stmt = db.prepare(sql)
    return stmt.all(...params) as Row[]
  }

  const runExecute = (sql: string, params: readonly unknown[]): ExecuteResult => {
    const stmt = db.prepare(sql)
    // `.run()` returns `{ changes, lastInsertRowid }`. sumak's
    // ExecuteResult only surfaces `affected` today; lastInsertRowid is
    // exposed via `RETURNING id` patterns or a follow-up query.
    const r = stmt.run(...params)
    return { affected: r.changes }
  }

  const base: Driver = {
    async query(sql, params, options) {
      checkSignal(options)
      return runQuery(sql, params)
    },
    async execute(sql, params, options) {
      checkSignal(options)
      return runExecute(sql, params)
    },
    async *stream(sql, params, options) {
      checkSignal(options)
      // better-sqlite3's .iterate() is sync-pull: each .next() runs
      // a synchronous call into the native binding, so the event
      // loop can still breathe between batches from the consumer's
      // `await`s but we don't prefetch. Aborted signal mid-stream
      // surfaces as the next yield throwing AbortError — callers
      // drop out of the `for await` and the iterator's finally
      // closes the statement.
      const stmt = db.prepare(sql)
      for (const row of stmt.iterate(...params)) {
        if (options?.signal?.aborted) throw new AbortError()
        yield row as Row
      }
    },
  }

  if (!captureTx) return base

  return {
    ...base,
    async transaction<T>(fn: (tx: Driver) => Promise<T>, options?: DriverCallOptions): Promise<T> {
      checkSignal(options)
      // SQLite allows only one writer at a time; BEGIN IMMEDIATE takes
      // the write lock up front to avoid a mid-transaction
      // SQLITE_BUSY. Reads are fine under the same lock.
      db.exec("BEGIN IMMEDIATE")
      try {
        const result = await fn(base)
        db.exec("COMMIT")
        return result
      } catch (err) {
        try {
          db.exec("ROLLBACK")
        } catch {
          // Swallow rollback failure — original error is what the
          // caller wants.
        }
        throw err
      }
    },
  }
}
