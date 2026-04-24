import { describe, expect, it } from "vitest"

import { mysql2Driver } from "../../src/drivers/mysql2.ts"

// mysql2's promise pool returns `[rowsOrOkPacket, fields]`. The adapter
// has to discriminate: rows come back as an array, OK packets come
// back as an object with `affectedRows`. Both paths are covered here.

type Query = { sql: string; params: readonly unknown[] }

function mockPool(opts: {
  rowsByPrefix?: Record<string, Record<string, unknown>[]>
  okByPrefix?: Record<string, { affectedRows: number }>
}) {
  const log: Query[] = []
  const connLog: Query[] = []
  let released = 0
  const events: string[] = []

  function result(sql: string): Record<string, unknown>[] | { affectedRows: number } {
    for (const [prefix, r] of Object.entries(opts.rowsByPrefix ?? {})) {
      if (sql.startsWith(prefix)) return r
    }
    for (const [prefix, r] of Object.entries(opts.okByPrefix ?? {})) {
      if (sql.startsWith(prefix)) return r
    }
    return { affectedRows: 0 }
  }

  const pool = {
    log,
    connLog,
    events,
    get released() {
      return released
    },
    async query(
      sql: string,
      values?: readonly unknown[],
    ): Promise<[Record<string, unknown>[] | { affectedRows: number }, unknown]> {
      log.push({ sql, params: values ?? [] })
      return [result(sql), []]
    },
    async getConnection() {
      return {
        async query(
          sql: string,
          values?: readonly unknown[],
        ): Promise<[Record<string, unknown>[] | { affectedRows: number }, unknown]> {
          connLog.push({ sql, params: values ?? [] })
          return [result(sql), []]
        },
        async beginTransaction() {
          events.push("BEGIN")
        },
        async commit() {
          events.push("COMMIT")
        },
        async rollback() {
          events.push("ROLLBACK")
        },
        release() {
          released++
        },
      }
    },
  }
  return pool
}

describe("mysql2Driver", () => {
  it("query — returns row array verbatim", async () => {
    const pool = mockPool({ rowsByPrefix: { SELECT: [{ id: 1 }, { id: 2 }] } })
    const driver = mysql2Driver(pool)
    const rows = await driver.query("SELECT * FROM users", [])
    expect(rows).toEqual([{ id: 1 }, { id: 2 }])
  })

  it("query — returns [] when the driver hands back an OK packet", async () => {
    const pool = mockPool({ okByPrefix: { DELETE: { affectedRows: 3 } } })
    const driver = mysql2Driver(pool)
    const rows = await driver.query("DELETE FROM tmp", [])
    expect(rows).toEqual([])
  })

  it("execute — reads affectedRows from the OK packet", async () => {
    const pool = mockPool({ okByPrefix: { UPDATE: { affectedRows: 5 } } })
    const driver = mysql2Driver(pool)
    const r = await driver.execute("UPDATE users SET ...", [])
    expect(r).toEqual({ affected: 5 })
  })

  it("execute — fallback affected=rows.length when the driver returns an array", async () => {
    const pool = mockPool({ rowsByPrefix: { INSERT: [{ id: 1 }, { id: 2 }] } })
    const driver = mysql2Driver(pool)
    const r = await driver.execute("INSERT ... RETURNING id", [])
    expect(r).toEqual({ affected: 2 })
  })

  it("transaction — delegates to beginTransaction/commit on resolve", async () => {
    const pool = mockPool({ rowsByPrefix: { SELECT: [{ ok: 1 }] } })
    const driver = mysql2Driver(pool)
    const result = await driver.transaction!(async (tx) => {
      const rows = await tx.query("SELECT 1 AS ok", [])
      expect(rows).toEqual([{ ok: 1 }])
      return 42
    })
    expect(result).toBe(42)
    expect(pool.events).toEqual(["BEGIN", "COMMIT"])
    expect(pool.released).toBe(1)
  })

  it("transaction — rollback on throw", async () => {
    const pool = mockPool({})
    const driver = mysql2Driver(pool)
    await expect(
      driver.transaction!(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(pool.events).toEqual(["BEGIN", "ROLLBACK"])
    expect(pool.released).toBe(1)
  })
})
