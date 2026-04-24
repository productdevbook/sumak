import { describe, expect, it } from "vitest"

import { mssqlDriver } from "../../src/drivers/mssql.ts"

// The `mssql` package binds positional params via `request.input("p0",
// value)` — the adapter has to build up the request that way. The
// mock request records its bindings so the test can assert them.

interface Recorded {
  sql: string
  inputs: Record<string, unknown>
}

function mockPool(opts: {
  recordsetByPrefix?: Record<string, Record<string, unknown>[]>
  affectedByPrefix?: Record<string, number>
}) {
  const requests: Recorded[] = []
  const txEvents: string[] = []
  let txRequestCount = 0

  function makeRequest(): {
    input: (name: string, value: unknown) => ReturnType<typeof makeRequest>
    query: (
      sql: string,
    ) => Promise<{ recordset: Record<string, unknown>[]; rowsAffected: number[] }>
  } {
    const rec: Recorded = { sql: "", inputs: {} }
    const req = {
      input(name: string, value: unknown) {
        rec.inputs[name] = value
        return req
      },
      async query(sql: string) {
        rec.sql = sql
        requests.push(rec)
        const recordset =
          Object.entries(opts.recordsetByPrefix ?? {}).find(([p]) => sql.startsWith(p))?.[1] ?? []
        const affected =
          Object.entries(opts.affectedByPrefix ?? {}).find(([p]) => sql.startsWith(p))?.[1] ?? 0
        return { recordset, rowsAffected: [affected] }
      },
    }
    return req
  }

  const pool = {
    requests,
    txEvents,
    get txRequestCount() {
      return txRequestCount
    },
    request: makeRequest,
    transaction() {
      return {
        async begin() {
          txEvents.push("BEGIN")
        },
        async commit() {
          txEvents.push("COMMIT")
        },
        async rollback() {
          txEvents.push("ROLLBACK")
        },
        request() {
          txRequestCount++
          return makeRequest()
        },
      }
    },
  }
  return pool
}

describe("mssqlDriver", () => {
  it("query — binds positional params as p0, p1, ... and returns recordset", async () => {
    const pool = mockPool({ recordsetByPrefix: { SELECT: [{ id: 1 }] } })
    const driver = mssqlDriver(pool)
    const rows = await driver.query("SELECT * FROM users WHERE id = @p0 AND active = @p1", [
      42,
      true,
    ])
    expect(rows).toEqual([{ id: 1 }])
    expect(pool.requests).toHaveLength(1)
    expect(pool.requests[0]!.inputs).toEqual({ p0: 42, p1: true })
  })

  it("execute — reports rowsAffected[0] as `affected`", async () => {
    const pool = mockPool({ affectedByPrefix: { UPDATE: 9 } })
    const driver = mssqlDriver(pool)
    const r = await driver.execute("UPDATE users SET x = @p0", ["y"])
    expect(r).toEqual({ affected: 9 })
  })

  it("transaction — begin/commit on resolve; per-statement request came from transaction", async () => {
    const pool = mockPool({ recordsetByPrefix: { SELECT: [{ ok: 1 }] } })
    const driver = mssqlDriver(pool)
    const result = await driver.transaction!(async (tx) => {
      await tx.query("SELECT 1 AS ok", [])
      return "done"
    })
    expect(result).toBe("done")
    expect(pool.txEvents).toEqual(["BEGIN", "COMMIT"])
    expect(pool.txRequestCount).toBe(1)
  })

  it("transaction — rollback on throw", async () => {
    const pool = mockPool({})
    const driver = mssqlDriver(pool)
    await expect(
      driver.transaction!(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(pool.txEvents).toEqual(["BEGIN", "ROLLBACK"])
  })
})
