import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { MissingDriverError } from "../../src/driver/execute.ts"
import type { Driver } from "../../src/driver/types.ts"
import { integer, serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"

// Records every call and can optionally fail on demand.
function recordingDriver(
  rows: Record<string, unknown>[] = [],
  failOn?: (sql: string) => boolean,
): Driver & {
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
      if (failOn?.(sql)) throw new Error(`mock fail: ${sql}`)
      return rows
    },
    async execute(sql, params) {
      calls.push({ kind: "execute", sql, params })
      if (failOn?.(sql)) throw new Error(`mock fail: ${sql}`)
      return { affected: 1 }
    },
  }
}

const TABLES = {
  users: { id: serial().primaryKey(), name: text().notNull(), age: integer().nullable() },
}

describe("db.transaction (manual BEGIN/COMMIT path)", () => {
  it("emits BEGIN, runs the block, and COMMITs on success", async () => {
    const driver = recordingDriver([{ id: 1, name: "Alice" }])
    const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

    const result = await db.transaction(async (tx) => {
      return tx
        .selectFrom("users")
        .where(({ id }) => id.eq(1))
        .one()
    })

    expect((result as { id: number }).id).toBe(1)
    const sqls = driver.calls.map((c) => c.sql.toUpperCase())
    expect(sqls[0]).toContain("BEGIN")
    expect(sqls.at(-1)).toContain("COMMIT")
  })

  it("ROLLBACKs when the block throws, then rethrows the caller's error", async () => {
    const driver = recordingDriver()
    const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

    const err = await db
      .transaction(async () => {
        throw new Error("boom")
      })
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("boom")
    const sqls = driver.calls.map((c) => c.sql.toUpperCase())
    expect(sqls[0]).toContain("BEGIN")
    expect(sqls.at(-1)).toContain("ROLLBACK")
  })

  it("passes isolation / readOnly options through to BEGIN", async () => {
    const driver = recordingDriver()
    const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })

    await db.transaction(async () => {}, { isolation: "SERIALIZABLE", readOnly: true })

    const begin = driver.calls[0]!.sql
    expect(begin).toContain("SERIALIZABLE")
    expect(begin).toContain("READ ONLY")
  })

  it("throws MissingDriverError when the Sumak instance has no driver", async () => {
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    await expect(db.transaction(async () => 1)).rejects.toBeInstanceOf(MissingDriverError)
  })

  it("propagates result:transform hooks from the parent into the tx scope", async () => {
    const driver = recordingDriver([{ id: 1, name: "alice" }])
    const db = sumak({ dialect: pgDialect(), driver, tables: TABLES })
    db.hook("result:transform", (rows) =>
      rows.map((r) => ({ ...r, name: String((r as { name: unknown }).name).toUpperCase() })),
    )

    const row = await db.transaction(async (tx) => tx.selectFrom("users").first())
    expect((row as { name: string }).name).toBe("ALICE")
  })
})

describe("db.transaction (driver-provided path)", () => {
  it("delegates to driver.transaction when the driver implements it", async () => {
    const innerDriver = recordingDriver([{ id: 7 }])
    let transactionCalls = 0
    const outer: Driver = {
      async query() {
        return []
      },
      async execute() {
        return { affected: 0 }
      },
      async transaction(fn) {
        transactionCalls++
        return fn(innerDriver)
      },
    }
    const db = sumak({ dialect: pgDialect(), driver: outer, tables: TABLES })

    const row = await db.transaction(async (tx) => tx.selectFrom("users").first())
    expect(transactionCalls).toBe(1)
    expect((row as { id: number }).id).toBe(7)
    // sumak should NOT have emitted BEGIN/COMMIT itself — the driver owns scoping.
    const emittedByOuter = innerDriver.calls.filter((c) =>
      /BEGIN|COMMIT|ROLLBACK/.test(c.sql.toUpperCase()),
    )
    expect(emittedByOuter).toHaveLength(0)
  })
})
