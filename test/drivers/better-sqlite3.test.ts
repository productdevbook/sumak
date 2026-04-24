import { describe, expect, it } from "vitest"

import { betterSqlite3Driver } from "../../src/drivers/better-sqlite3.ts"

// better-sqlite3 is synchronous; the adapter wraps that into the Driver
// Promise interface. We mock just the slice of the Database class we
// use: `prepare(sql)` returning a Statement with `.all()` / `.run()`,
// plus `.exec(sql)` for DDL / TCL.

function mockDb(opts: {
  rowsByPrefix?: Record<string, Record<string, unknown>[]>
  runByPrefix?: Record<string, { changes: number; lastInsertRowid: number }>
}) {
  const log: { sql: string; method: "all" | "run" | "exec"; params: unknown[] }[] = []

  return {
    log,
    prepare(sql: string) {
      return {
        all(...params: unknown[]) {
          log.push({ sql, method: "all", params })
          for (const [prefix, rows] of Object.entries(opts.rowsByPrefix ?? {})) {
            if (sql.startsWith(prefix)) return rows
          }
          return []
        },
        run(...params: unknown[]) {
          log.push({ sql, method: "run", params })
          for (const [prefix, r] of Object.entries(opts.runByPrefix ?? {})) {
            if (sql.startsWith(prefix)) return r
          }
          return { changes: 0, lastInsertRowid: 0 }
        },
        *iterate(...params: unknown[]) {
          log.push({ sql, method: "all", params })
          for (const [prefix, rows] of Object.entries(opts.rowsByPrefix ?? {})) {
            if (sql.startsWith(prefix)) {
              for (const r of rows) yield r
              return
            }
          }
        },
      }
    },
    exec(sql: string) {
      log.push({ sql, method: "exec", params: [] })
    },
  }
}

describe("betterSqlite3Driver", () => {
  it("query — wraps .all() synchronously and returns rows", async () => {
    const db = mockDb({ rowsByPrefix: { SELECT: [{ id: 1, name: "Alice" }] } })
    const driver = betterSqlite3Driver(db)
    const rows = await driver.query("SELECT * FROM users", [])
    expect(rows).toEqual([{ id: 1, name: "Alice" }])
  })

  it("execute — reports `changes` as `affected`", async () => {
    const db = mockDb({ runByPrefix: { UPDATE: { changes: 7, lastInsertRowid: 0 } } })
    const driver = betterSqlite3Driver(db)
    const r = await driver.execute("UPDATE users SET ...", [])
    expect(r).toEqual({ affected: 7 })
  })

  it("transaction — BEGIN IMMEDIATE / COMMIT on resolve", async () => {
    const db = mockDb({ rowsByPrefix: { SELECT: [{ ok: 1 }] } })
    const driver = betterSqlite3Driver(db)
    const result = await driver.transaction!(async (tx) => {
      await tx.query("SELECT 1", [])
      return "yes"
    })
    expect(result).toBe("yes")
    const execSqls = db.log.filter((e) => e.method === "exec").map((e) => e.sql)
    expect(execSqls).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
  })

  it("transaction — ROLLBACK on throw", async () => {
    const db = mockDb({})
    const driver = betterSqlite3Driver(db)
    await expect(
      driver.transaction!(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    const execSqls = db.log.filter((e) => e.method === "exec").map((e) => e.sql)
    expect(execSqls).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"])
  })

  it("stream — delegates to prepare().iterate() and yields row by row", async () => {
    const db = mockDb({
      rowsByPrefix: { SELECT: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    })
    const driver = betterSqlite3Driver(db)
    const seen: unknown[] = []
    for await (const row of driver.stream!("SELECT * FROM t", [])) {
      seen.push(row)
    }
    expect(seen).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })
})
