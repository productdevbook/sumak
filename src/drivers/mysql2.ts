import type { Driver, ExecuteResult, Row } from "../driver/types.ts"

/**
 * Narrow slice of `mysql2`'s promise pool surface. The real package
 * exports `Pool` / `PoolConnection` with many additional methods; sumak
 * only needs `query` + the connection lifecycle. Shaping the dependency
 * this way lets callers pass in a real `mysql2.Pool` without a peer
 * import and lets tests hand in a mock with the same three methods.
 */
export interface Mysql2Queryable {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<[Record<string, unknown>[] | Mysql2OkPacket, unknown]>
}

/**
 * mysql2 returns a `ResultSetHeader`-like OK packet on non-SELECT
 * statements and an array of row objects on SELECT. We destructure at
 * runtime because the shape depends on the statement type.
 */
export interface Mysql2OkPacket {
  affectedRows: number
  insertId?: number | bigint
}

export interface Mysql2Pool extends Mysql2Queryable {
  getConnection(): Promise<Mysql2Connection>
}

export interface Mysql2Connection extends Mysql2Queryable {
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

export interface Mysql2DriverOptions {
  readonly captureTransactions?: boolean
}

/**
 * Adapt a `mysql2/promise` Pool (or any {@link Mysql2Pool}-shaped
 * object) to sumak's {@link Driver}. mysql2 uses `?` placeholders, which
 * sumak's MySQL printer already emits, so params flow through
 * unchanged.
 *
 * ```ts
 * import { createPool } from "mysql2/promise"
 * import { sumak } from "sumak"
 * import { mysql2Driver } from "sumak/drivers/mysql2"
 *
 * const pool = createPool({ uri: process.env.DATABASE_URL })
 * const db = sumak({ dialect: mysqlDialect(), driver: mysql2Driver(pool), tables })
 * ```
 *
 * mysql2's Connection speaks `beginTransaction` / `commit` / `rollback`
 * directly (no textual BEGIN), so we delegate to those when the caller
 * opts into {@link Driver.transaction}. Leaving `captureTransactions`
 * off falls back to sumak's default TCL emission on the shared pool.
 */
export function mysql2Driver(
  pool: Mysql2Pool | Mysql2Queryable,
  options: Mysql2DriverOptions = {},
): Driver {
  const captureTx = options.captureTransactions ?? true

  const runQuery = async (client: Mysql2Queryable, sql: string, params: readonly unknown[]) => {
    const [rows] = await client.query(sql, params)
    // mysql2 returns either a row array or an OK packet; the OK packet
    // shape is `{ affectedRows, ... }` — definitely not a row list.
    if (!Array.isArray(rows)) return [] as Row[]
    return rows as Row[]
  }

  const runExecute = async (client: Mysql2Queryable, sql: string, params: readonly unknown[]) => {
    const [result] = await client.query(sql, params)
    if (Array.isArray(result)) return { affected: result.length } satisfies ExecuteResult
    const ok = result as Mysql2OkPacket
    return { affected: ok.affectedRows ?? 0 } satisfies ExecuteResult
  }

  const base: Driver = {
    async query(sql, params) {
      return runQuery(pool, sql, params)
    },
    async execute(sql, params) {
      return runExecute(pool, sql, params)
    },
  }

  if (!captureTx || !("getConnection" in pool) || typeof pool.getConnection !== "function") {
    return base
  }

  return {
    ...base,
    async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
      const conn = await (pool as Mysql2Pool).getConnection()
      const scoped: Driver = {
        async query(sql, params) {
          return runQuery(conn, sql, params)
        },
        async execute(sql, params) {
          return runExecute(conn, sql, params)
        },
      }
      await conn.beginTransaction()
      try {
        const result = await fn(scoped)
        await conn.commit()
        return result
      } catch (err) {
        try {
          await conn.rollback()
        } catch {
          // As with pg, an already-broken connection may reject
          // ROLLBACK; the original error wins.
        }
        throw err
      } finally {
        conn.release()
      }
    },
  }
}
