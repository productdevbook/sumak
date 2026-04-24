import type { Driver, ExecuteResult, Row } from "../driver/types.ts"

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
    async query(sql, params) {
      return runQuery(sql, params)
    },
    async execute(sql, params) {
      return runExecute(sql, params)
    },
  }

  if (!captureTx) return base

  return {
    ...base,
    async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
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
