import { describe, expect, it } from "vitest"

import { pgDriver } from "../../src/drivers/pg.ts"

// Exercise the pg adapter against a hand-rolled pool that matches the
// tiny `PgPool` interface sumak consumes. We assert two things here:
// (1) SQL + params go through verbatim, and (2) transaction() opens a
// pool client, emits BEGIN / COMMIT or BEGIN / ROLLBACK at the right
// moments, and always release()-s the client.

type Query = { sql: string; params: readonly unknown[] }

function mockPool(rowsByPrefix: Record<string, Record<string, unknown>[]> = {}) {
  const log: Query[] = []
  const clientLog: Query[] = []
  let released = 0

  function rows(sql: string): Record<string, unknown>[] {
    for (const [prefix, r] of Object.entries(rowsByPrefix)) {
      if (sql.startsWith(prefix)) return r
    }
    return []
  }

  const pool = {
    log,
    clientLog,
    get released() {
      return released
    },
    async query(sql: string, values?: readonly unknown[]) {
      log.push({ sql, params: values ?? [] })
      const r = rows(sql)
      return { rows: r, rowCount: r.length }
    },
    async connect() {
      return {
        async query(sql: string, values?: readonly unknown[]) {
          clientLog.push({ sql, params: values ?? [] })
          const r = rows(sql)
          return { rows: r, rowCount: r.length }
        },
        release() {
          released++
        },
      }
    },
  }
  return pool
}

describe("pgDriver", () => {
  it("query — passes SQL + params through and returns rows", async () => {
    const pool = mockPool({ SELECT: [{ id: 1, name: "Alice" }] })
    const driver = pgDriver(pool)
    const rows = await driver.query("SELECT * FROM users WHERE id = $1", [1])
    expect(rows).toEqual([{ id: 1, name: "Alice" }])
    expect(pool.log).toEqual([{ sql: "SELECT * FROM users WHERE id = $1", params: [1] }])
  })

  it("execute — reports rowCount as `affected`, defaulting to 0", async () => {
    const pool = mockPool()
    const driver = pgDriver(pool)
    const r = await driver.execute("UPDATE users SET active = false", [])
    expect(r).toEqual({ affected: 0 })
  })

  it("transaction — BEGIN / COMMIT on resolve; client released", async () => {
    const pool = mockPool({ SELECT: [{ ok: 1 }] })
    const driver = pgDriver(pool)
    const result = await driver.transaction!(async (tx) => {
      const rows = await tx.query("SELECT 1 AS ok", [])
      expect(rows).toEqual([{ ok: 1 }])
      return "done"
    })
    expect(result).toBe("done")
    const sqls = pool.clientLog.map((q) => q.sql)
    expect(sqls).toEqual(["BEGIN", "SELECT 1 AS ok", "COMMIT"])
    expect(pool.released).toBe(1)
  })

  it("transaction — BEGIN / ROLLBACK on throw; original error surfaces; client released", async () => {
    const pool = mockPool()
    const driver = pgDriver(pool)
    const bomb = new Error("boom")
    await expect(
      driver.transaction!(async () => {
        throw bomb
      }),
    ).rejects.toBe(bomb)
    const sqls = pool.clientLog.map((q) => q.sql)
    expect(sqls).toEqual(["BEGIN", "ROLLBACK"])
    expect(pool.released).toBe(1)
  })

  it("captureTransactions: false — base driver has no transaction override", () => {
    const pool = mockPool()
    const driver = pgDriver(pool, { captureTransactions: false })
    expect(driver.transaction).toBeUndefined()
  })
})
