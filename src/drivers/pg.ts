import type { Driver, DriverCallOptions, ExecuteResult, Row } from "../driver/types.ts"
import { withSignal } from "../driver/types.ts"

/**
 * Shape of the bits of `pg.Pool` / `pg.Client` / `pg.PoolClient` that
 * sumak actually uses — intentionally narrow so callers can pass in a
 * real `pg.Pool` without a peer-dep import and so tests can pass a
 * hand-rolled mock with the same surface.
 *
 * `node-postgres` is 100% ESM-compatible at runtime but its bundled
 * types sometimes leak `any` in places; we quote only what we need.
 */
export interface PgQueryable {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}

/**
 * `pg.Pool` exposes `connect()` which hands back a PoolClient that must
 * be `release()`-ed. sumak uses this when the caller opts into
 * transactions: one client is checked out for the BEGIN..COMMIT span so
 * every statement runs on the same connection.
 */
export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>
}

/**
 * A checked-out pool client. Same `query` surface as the pool plus
 * `release()` to return it to the pool.
 */
export interface PgClient extends PgQueryable {
  release(err?: Error | boolean): void
}

/**
 * Options for {@link pgDriver}.
 *
 * `captureTransactions` (default: true) switches `db.transaction(...)`
 * onto a dedicated PoolClient via `BEGIN` / `COMMIT` / `ROLLBACK`. Set
 * it to `false` if you're wiring savepoints yourself or if the passed
 * object is already a single client where pool checkout doesn't
 * apply — sumak will then emit TCL statements on the shared queryable.
 */
export interface PgDriverOptions {
  readonly captureTransactions?: boolean
}

/**
 * Adapt a `pg.Pool` (or any object with the {@link PgPool} /
 * {@link PgQueryable} shape) to sumak's {@link Driver} contract.
 *
 * ```ts
 * import { Pool } from "pg"
 * import { sumak } from "sumak"
 * import { pgDriver } from "sumak/drivers/pg"
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * const db = sumak({ dialect: pgDialect(), driver: pgDriver(pool), tables })
 * ```
 */
export function pgDriver(pool: PgPool | PgQueryable, options: PgDriverOptions = {}): Driver {
  const captureTx = options.captureTransactions ?? true

  const run = async (
    client: PgQueryable,
    sql: string,
    params: readonly unknown[],
    opts: DriverCallOptions | undefined,
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    // node-postgres doesn't expose per-request cancellation on its
    // public API (cancellation requires a separate control connection
    // to `pg_cancel_backend`). As a pragmatic default we race the
    // query against the signal so the caller's promise rejects
    // promptly; the underlying connection finishes whatever it's
    // doing in the background. Callers that need true wire-level
    // cancellation should pull the client out of the pool and issue
    // `pg_cancel_backend` themselves.
    const inflight = client.query(sql, params).then((r) => ({
      rows: r.rows,
      rowCount: r.rowCount ?? 0,
    }))
    return withSignal(opts?.signal, inflight)
  }

  const base: Driver = {
    async query(sql, params, options) {
      const { rows } = await run(pool, sql, params, options)
      return rows
    },
    async execute(sql, params, options) {
      const { rowCount } = await run(pool, sql, params, options)
      return { affected: rowCount } satisfies ExecuteResult
    },
  }

  if (!captureTx || !("connect" in pool) || typeof pool.connect !== "function") {
    return base
  }

  return {
    ...base,
    async transaction<T>(fn: (tx: Driver) => Promise<T>, options?: DriverCallOptions): Promise<T> {
      const client = await (pool as PgPool).connect()
      // Wrap the client as a scoped Driver that shares the same
      // connection for the life of the transaction. No nested
      // transaction support at this layer — callers who want
      // savepoints can use sumak's `tx.savepoint(...)` directly.
      const scoped: Driver = {
        async query(sql, params, opts) {
          const { rows } = await run(client, sql, params, opts ?? options)
          return rows
        },
        async execute(sql, params, opts) {
          const { rowCount } = await run(client, sql, params, opts ?? options)
          return { affected: rowCount } satisfies ExecuteResult
        },
      }
      await client.query("BEGIN", [])
      try {
        const result = await withSignal(options?.signal, fn(scoped))
        await client.query("COMMIT", [])
        return result
      } catch (err) {
        try {
          await client.query("ROLLBACK", [])
        } catch {
          // ROLLBACK can fail when the connection is already broken;
          // surface the original error rather than the rollback one.
        }
        throw err
      } finally {
        client.release()
      }
    },
  }
}
