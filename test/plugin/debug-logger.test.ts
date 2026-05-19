import { describe, expect, it, vi } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import type { Driver, OnQueryListener, QueryEvent, Row } from "../../src/driver/types.ts"
import {
  type DebugLogEntry,
  DebugLoggerPlugin,
  debugLogger,
} from "../../src/plugin/debug-logger.ts"
import { audit } from "../../src/plugin/factories.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// A lightweight in-memory Driver for tests that need to drive
// `onQuery` events without pulling a real database in. Each method
// records its call and returns the canned result the test supplied.
function makeDriver(opts: { rows?: Row[]; affected?: number; shouldThrow?: () => Error }): Driver {
  return {
    async query() {
      if (opts.shouldThrow) throw opts.shouldThrow()
      return opts.rows ?? []
    },
    async execute() {
      if (opts.shouldThrow) throw opts.shouldThrow()
      return { affected: opts.affected ?? 0 }
    },
  }
}

const tables = {
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
  },
}

describe("debugLogger — compile-phase logging", () => {
  it("emits one `compile` entry per compiled query, with sql + params", () => {
    const entries: DebugLogEntry[] = []
    const db = sumak({
      dialect: pgDialect(),
      tables,
      plugins: [debugLogger({ sink: (e) => entries.push(e), color: false })],
    })

    db.selectFrom("users")
      .select("id", "name")
      .where(({ id }) => id.eq(7))
      .toSQL()

    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry?.phase).toBe("compile")
    expect(entry?.sql).toMatch(/SELECT.*"id".*"name".*FROM "users"/)
    expect(entry?.sql).toMatch(/"id" = \$1/)
    expect(entry?.params).toEqual([7])
  })

  it("INSERT / UPDATE / DELETE all emit a compile entry", () => {
    const entries: DebugLogEntry[] = []
    const db = sumak({
      dialect: pgDialect(),
      tables,
      plugins: [debugLogger({ sink: (e) => entries.push(e), color: false })],
    })
    db.insertInto("users").values({ name: "Alice" }).toSQL()
    db.update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    db.deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(entries.map((e) => e.phase)).toEqual(["compile", "compile", "compile"])
    expect(entries[0]?.sql).toMatch(/^INSERT/)
    expect(entries[1]?.sql).toMatch(/^UPDATE/)
    expect(entries[2]?.sql).toMatch(/^DELETE/)
  })

  it("does not interfere with the produced SQL/params (observer-only)", () => {
    const entries: DebugLogEntry[] = []
    const dbA = sumak({ dialect: pgDialect(), tables })
    const dbB = sumak({
      dialect: pgDialect(),
      tables,
      plugins: [debugLogger({ sink: (e) => entries.push(e), color: false })],
    })
    const queryA = dbA.insertInto("users").values({ name: "Ada" }).toSQL()
    const queryB = dbB.insertInto("users").values({ name: "Ada" }).toSQL()

    expect(queryB.sql).toBe(queryA.sql)
    expect(queryB.params).toEqual(queryA.params)
    // …and the plugin did fire.
    expect(entries).toHaveLength(1)
  })
})

describe("debugLogger — filter", () => {
  it("skips entries when filter returns false", () => {
    const entries: DebugLogEntry[] = []
    const db = sumak({
      dialect: pgDialect(),
      tables,
      plugins: [
        debugLogger({
          sink: (e) => entries.push(e),
          filter: (e) => !e.sql.startsWith("SELECT"),
          color: false,
        }),
      ],
    })
    db.selectFrom("users").select("id").toSQL()
    db.insertInto("users").values({ name: "Bob" }).toSQL()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.sql).toMatch(/^INSERT/)
  })
})

describe("debugLogger — slowQueryMs", () => {
  it("only emits `exec-end` for events at/above the threshold", () => {
    const entries: DebugLogEntry[] = []
    const plugin = new DebugLoggerPlugin({
      sink: (e) => entries.push(e),
      slowQueryMs: 50,
      color: false,
    })
    const listener = plugin.asOnQueryListener()
    // Fast — suppressed.
    listener({
      phase: "start",
      kind: "query",
      sql: "SELECT 1",
      params: [],
      id: 1,
    } as QueryEvent)
    listener({
      phase: "end",
      kind: "query",
      sql: "SELECT 1",
      params: [],
      id: 1,
      durationMs: 4,
      rowCount: 1,
    } as QueryEvent)
    // Slow — emitted with `slow: true`.
    listener({
      phase: "start",
      kind: "query",
      sql: "SELECT pg_sleep(1)",
      params: [],
      id: 2,
    } as QueryEvent)
    listener({
      phase: "end",
      kind: "query",
      sql: "SELECT pg_sleep(1)",
      params: [],
      id: 2,
      durationMs: 1024,
      rowCount: 1,
    } as QueryEvent)
    const phases = entries.map((e) => e.phase)
    expect(phases).toEqual(["exec-start", "exec-start", "exec-end"])
    const slowEnd = entries.find((e) => e.phase === "exec-end")
    expect(slowEnd?.slow).toBe(true)
    expect(slowEnd?.durationMs).toBe(1024)
  })

  it("`exec-error` always fires regardless of slowQueryMs", () => {
    const entries: DebugLogEntry[] = []
    const plugin = new DebugLoggerPlugin({
      sink: (e) => entries.push(e),
      slowQueryMs: 999_999,
      color: false,
    })
    const listener = plugin.asOnQueryListener()
    listener({
      phase: "error",
      kind: "query",
      sql: "SELECT 1",
      params: [],
      id: 1,
      durationMs: 0.1,
      error: new Error("boom"),
    } as QueryEvent)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.phase).toBe("exec-error")
    expect(entries[0]?.error).toBeInstanceOf(Error)
  })

  it("without slowQueryMs every `end` is emitted", () => {
    const entries: DebugLogEntry[] = []
    const plugin = new DebugLoggerPlugin({
      sink: (e) => entries.push(e),
      color: false,
    })
    const listener = plugin.asOnQueryListener()
    listener({
      phase: "end",
      kind: "query",
      sql: "SELECT 1",
      params: [],
      id: 1,
      durationMs: 0.5,
      rowCount: 1,
    } as QueryEvent)
    expect(entries[0]?.phase).toBe("exec-end")
    expect(entries[0]?.slow).toBeUndefined()
    expect(entries[0]?.rowCount).toBe(1)
  })
})

describe("debugLogger — custom sink + colour", () => {
  it("custom sink receives entries; default sink is bypassed", () => {
    const sink = vi.fn()
    const db = sumak({
      dialect: pgDialect(),
      tables,
      plugins: [debugLogger({ sink })],
    })
    db.selectFrom("users").select("id").toSQL()
    expect(sink).toHaveBeenCalledOnce()
    const entry = sink.mock.calls[0]?.[0] as DebugLogEntry
    expect(entry?.phase).toBe("compile")
  })

  it("default sink emits ANSI when color: true, plain when false", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const dbColor = sumak({
        dialect: pgDialect(),
        tables,
        plugins: [debugLogger({ color: true })],
      })
      dbColor.selectFrom("users").select("id").toSQL()
      const colored = spy.mock.calls[0]?.[0] as string
      expect(colored).toMatch(/\[/) // ANSI escape introducer
      expect(colored).toContain("[COMPILE]")
      spy.mockClear()

      const dbPlain = sumak({
        dialect: pgDialect(),
        tables,
        plugins: [debugLogger({ color: false })],
      })
      dbPlain.selectFrom("users").select("id").toSQL()
      const plain = spy.mock.calls[0]?.[0] as string
      expect(plain).not.toMatch(/\[/)
      expect(plain).toContain("[COMPILE]")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("debugLogger — exec phase via driver path", () => {
  it("captures exec-start + exec-end (rowCount) around a successful query", async () => {
    const entries: DebugLogEntry[] = []
    const db = sumak({
      dialect: pgDialect(),
      tables,
      driver: makeDriver({ rows: [{ id: 1, name: "Alice" }] }),
      plugins: [debugLogger({ sink: (e) => entries.push(e), color: false })],
    })
    await db.selectFrom("users").selectAll().many()
    const phases = entries.map((e) => e.phase)
    // compile fires first (from `query:after`), then exec-start, then exec-end.
    expect(phases).toEqual(["compile", "exec-start", "exec-end"])
    const end = entries.find((e) => e.phase === "exec-end")
    expect(end?.rowCount).toBe(1)
    expect(end?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("captures exec-error when the driver throws", async () => {
    const entries: DebugLogEntry[] = []
    const db = sumak({
      dialect: pgDialect(),
      tables,
      driver: makeDriver({ shouldThrow: () => new Error("boom") }),
      plugins: [debugLogger({ sink: (e) => entries.push(e), color: false })],
    })
    await expect(db.selectFrom("users").selectAll().many()).rejects.toThrow("boom")
    const phases = entries.map((e) => e.phase)
    expect(phases).toContain("exec-error")
    const errEntry = entries.find((e) => e.phase === "exec-error")
    expect(errEntry?.error).toBeInstanceOf(Error)
    expect(errEntry?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("coexists with the user-provided onQuery listener (both fire)", async () => {
    const userEvents: QueryEvent[] = []
    const pluginEntries: DebugLogEntry[] = []
    const listener: OnQueryListener = (e) => userEvents.push(e)
    const db = sumak({
      dialect: pgDialect(),
      tables,
      driver: makeDriver({ rows: [] }),
      onQuery: listener,
      plugins: [debugLogger({ sink: (e) => pluginEntries.push(e), color: false })],
    })
    await db.selectFrom("users").selectAll().many()
    // User listener saw both events…
    expect(userEvents.map((e) => e.phase)).toEqual(["start", "end"])
    // …and the plugin saw compile + exec-start + exec-end.
    expect(pluginEntries.map((e) => e.phase)).toEqual(["compile", "exec-start", "exec-end"])
  })

  it("a throwing sink does not take down the user's onQuery listener (errors swallowed)", async () => {
    const userEvents: QueryEvent[] = []
    const listener: OnQueryListener = (e) => userEvents.push(e)
    const db = sumak({
      dialect: pgDialect(),
      tables,
      driver: makeDriver({ rows: [] }),
      onQuery: listener,
      plugins: [
        debugLogger({
          sink: () => {
            throw new Error("sink blew up")
          },
          color: false,
        }),
      ],
    })
    await expect(db.selectFrom("users").selectAll().many()).resolves.toEqual([])
    expect(userEvents.map((e) => e.phase)).toEqual(["start", "end"])
  })
})

describe("debugLogger — plays nicely with other plugins", () => {
  it("does not break audit / SQL stays parameterised", () => {
    const entries: DebugLogEntry[] = []
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
      plugins: [
        audit({ tables: ["users"] }),
        debugLogger({ sink: (e) => entries.push(e), color: false }),
      ],
    })
    const { sql, params } = db.insertInto("users").values({ name: "Z" }).toSQL()
    // audit added created_at/updated_at; debug-logger merely observed.
    expect(sql).toContain("CURRENT_TIMESTAMP")
    expect(params).toEqual(["Z"])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.sql).toBe(sql)
    expect(entries[0]?.params).toEqual(params)
  })

  it("transaction-scoped queries are observed without double-firing setup", async () => {
    const entries: DebugLogEntry[] = []
    const db = sumak({
      dialect: pgDialect(),
      tables,
      driver: makeDriver({ rows: [] }),
      plugins: [debugLogger({ sink: (e) => entries.push(e), color: false })],
    })
    await db.transaction(async (tx) => {
      await tx.selectFrom("users").selectAll().many()
    })
    // The plugin sees one BEGIN/COMMIT pair (the scope-level transaction
    // events) plus the inner SELECT's compile + exec-start + exec-end —
    // five entries total. If `_skipPluginSetup` / the shared
    // `_pluginOnQuery` array regressed, every event would double up.
    expect(entries.map((e) => e.phase)).toEqual([
      "exec-start", // BEGIN — scope-level "transaction" start
      "compile", // inner SELECT compiled
      "exec-start", // inner SELECT dispatched
      "exec-end", // inner SELECT resolved
      "exec-end", // COMMIT — scope-level "transaction" end
    ])
    // The BEGIN / COMMIT lines are emitted via the scope wrapper, not
    // Sumak.compile(), so they don't show up as `compile` entries.
    expect(entries.filter((e) => e.phase === "compile")).toHaveLength(1)
    expect(entries.filter((e) => e.phase === "compile")[0]?.sql).toMatch(/SELECT/)
  })
})
