import type { Driver, ExecuteResult, Row } from "../driver/types.ts"

/**
 * Narrow slice of the `mssql` (tedious-based) package's ConnectionPool
 * surface. `Request` objects carry per-statement parameter bindings
 * via `.input(name, value)` and ultimately speak `.query(sql)` /
 * `.batch(sql)`. sumak's MSSQL printer emits `@p0`, `@p1`, … so we
 * bind each positional param under `p${i}`.
 */
export interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest
  /**
   * `mssql`'s real `.query<T>(sql)` takes a generic to annotate the
   * row type; sumak doesn't need it and declares the erased form so a
   * hand-rolled mock with concrete `Record<string, unknown>` rows is
   * assignable to {@link MssqlRequest}. Drivers whose typings force a
   * generic can be cast at the call site (`pool as MssqlPool`).
   */
  query(sql: string): Promise<{
    recordset?: Record<string, unknown>[]
    recordsets?: Record<string, unknown>[][]
    rowsAffected: number[]
  }>
}

export interface MssqlTransaction {
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  request(): MssqlRequest
}

export interface MssqlPool {
  request(): MssqlRequest
  transaction(): MssqlTransaction
}

export interface MssqlDriverOptions {
  readonly captureTransactions?: boolean
}

/**
 * Adapt a `mssql` ConnectionPool (or any {@link MssqlPool}-shaped
 * object) to sumak's {@link Driver}. sumak's MSSQL printer emits `@p0`,
 * `@p1`, … placeholders; this adapter binds the positional params list
 * to those names via `request.input("p" + i, value)`.
 *
 * ```ts
 * import sql from "mssql"
 * import { sumak } from "sumak"
 * import { mssqlDriver } from "sumak/drivers/mssql"
 *
 * const pool = await sql.connect(connString)
 * const db = sumak({ dialect: mssqlDialect(), driver: mssqlDriver(pool), tables })
 * ```
 *
 * Transactions: the `mssql` package exposes a Transaction object that
 * bundles `BEGIN` / `COMMIT` / `ROLLBACK` + per-statement `request()`.
 * sumak delegates to it when `captureTransactions` is true.
 */
export function mssqlDriver(pool: MssqlPool, options: MssqlDriverOptions = {}): Driver {
  const captureTx = options.captureTransactions ?? true

  const bindParams = (request: MssqlRequest, params: readonly unknown[]): MssqlRequest => {
    for (let i = 0; i < params.length; i++) {
      request.input(`p${i}`, params[i])
    }
    return request
  }

  const runQuery = async (
    requestFactory: () => MssqlRequest,
    sql: string,
    params: readonly unknown[],
  ): Promise<Row[]> => {
    const r = await bindParams(requestFactory(), params).query(sql)
    return (r.recordset ?? []) as Row[]
  }

  const runExecute = async (
    requestFactory: () => MssqlRequest,
    sql: string,
    params: readonly unknown[],
  ): Promise<ExecuteResult> => {
    const r = await bindParams(requestFactory(), params).query(sql)
    // `rowsAffected` is an array (one entry per result set); for a
    // single-statement request the first slot holds the total.
    const affected = Array.isArray(r.rowsAffected) ? (r.rowsAffected[0] ?? 0) : 0
    return { affected }
  }

  const base: Driver = {
    async query(sql, params) {
      return runQuery(() => pool.request(), sql, params)
    },
    async execute(sql, params) {
      return runExecute(() => pool.request(), sql, params)
    },
  }

  if (!captureTx) return base

  return {
    ...base,
    async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
      const tx = pool.transaction()
      await tx.begin()
      const scoped: Driver = {
        async query(sql, params) {
          return runQuery(() => tx.request(), sql, params)
        },
        async execute(sql, params) {
          return runExecute(() => tx.request(), sql, params)
        },
      }
      try {
        const result = await fn(scoped)
        await tx.commit()
        return result
      } catch (err) {
        try {
          await tx.rollback()
        } catch {
          // Rollback can fail if the transaction is already aborted
          // by the server (e.g. XACT_ABORT). Keep the original error.
        }
        throw err
      }
    },
  }
}
