import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import type { Driver } from "../../src/driver/types.ts"
import {
  applyMigration,
  MigrationRequiresDriverError,
  planMigration,
  runPlan,
} from "../../src/migrate/runner.ts"
import { serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"

function recordingDriver(): Driver & {
  calls: { kind: "query" | "execute"; sql: string; params: readonly unknown[] }[]
} {
  const calls: {
    kind: "query" | "execute"
    sql: string
    params: readonly unknown[]
  }[] = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ kind: "query", sql, params })
      return []
    },
    async execute(sql, params) {
      calls.push({ kind: "execute", sql, params })
      return { affected: 0 }
    },
  }
}

describe("planMigration", () => {
  it("returns compiled steps + nodes and a destructive-flag summary", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const plan = planMigration(
      db,
      {},
      { users: { id: serial().primaryKey(), name: text().notNull() } },
    )
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.sql).toMatch(/CREATE TABLE/i)
    expect(plan.hasDestructiveSteps).toBe(false)
  })

  it("flags hasDestructiveSteps when allowed drops are in the plan", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const plan = planMigration(
      db,
      { old_t: { id: serial().primaryKey() } },
      {},
      {
        allowDestructive: true,
      },
    )
    expect(plan.hasDestructiveSteps).toBe(true)
  })

  it("does NOT need a driver (planning is pure)", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    expect(() => planMigration(db, {}, { t: { id: serial().primaryKey() } })).not.toThrow()
  })
})

describe("applyMigration / runPlan", () => {
  it("executes each compiled step through driver.execute", async () => {
    const driver = recordingDriver()
    const db = sumak({ dialect: pgDialect(), driver, tables: {} })

    const result = await applyMigration(
      db,
      {},
      { users: { id: serial().primaryKey(), name: text().notNull() } },
    )
    expect(result.applied).toBe(1)
    expect(result.statements[0]).toMatch(/CREATE TABLE/)

    // Inside a transaction by default — we expect a BEGIN, then the CREATE, then COMMIT.
    const sqls = driver.calls.map((c) => c.sql.toUpperCase())
    expect(sqls[0]).toContain("BEGIN")
    expect(sqls.at(-1)).toContain("COMMIT")
    expect(sqls).toContain(result.statements[0]!.toUpperCase())
  })

  it("no-op migration reports applied:0", async () => {
    const driver = recordingDriver()
    const db = sumak({ dialect: pgDialect(), driver, tables: {} })
    const schema = { users: { id: serial().primaryKey() } }
    const result = await applyMigration(db, schema, schema)
    expect(result.applied).toBe(0)
    expect(driver.calls).toHaveLength(0) // no transaction fired for empty plan
  })

  it("transaction: false skips the BEGIN/COMMIT wrapping", async () => {
    const driver = recordingDriver()
    const db = sumak({ dialect: pgDialect(), driver, tables: {} })
    await applyMigration(db, {}, { users: { id: serial().primaryKey() } }, { transaction: false })
    const sqls = driver.calls.map((c) => c.sql.toUpperCase())
    expect(sqls.some((s) => s.includes("BEGIN"))).toBe(false)
    expect(sqls.some((s) => s.includes("CREATE TABLE"))).toBe(true)
  })

  it("throws MigrationRequiresDriverError when applying without a driver", async () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    await expect(
      applyMigration(db, {}, { users: { id: serial().primaryKey() } }),
    ).rejects.toBeInstanceOf(MigrationRequiresDriverError)
  })

  it("rolls back on a mid-migration failure (transaction path)", async () => {
    // Driver that succeeds on BEGIN, fails on the first CREATE.
    const driver: Driver = {
      async query() {
        return []
      },
      async execute(sql) {
        if (/^CREATE TABLE/i.test(sql.trim())) throw new Error("mock DDL fail")
        return { affected: 0 }
      },
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: {} })
    await expect(applyMigration(db, {}, { users: { id: serial().primaryKey() } })).rejects.toThrow(
      "mock DDL fail",
    )
  })

  it("runPlan re-executes an already-computed plan", async () => {
    const driver = recordingDriver()
    const db = sumak({ dialect: pgDialect(), driver, tables: {} })
    const plan = planMigration(db, {}, { users: { id: serial().primaryKey() } })

    const result = await runPlan(db, plan)
    expect(result.applied).toBe(1)
  })
})
