import { describe, expect, it } from "vitest"

import { runStream } from "../../src/driver/execute.ts"
import type { Driver, QueryEvent } from "../../src/driver/types.ts"

// runStream is the execute-layer helper that wraps Driver.stream (or
// falls back to Driver.query + yield) and emits start/end/error
// events. These unit tests exercise all three branches.

function driverWithStream(rows: Record<string, unknown>[]): Driver {
  return {
    async query() {
      throw new Error("should not be called when stream() is provided")
    },
    async execute() {
      return { affected: 0 }
    },
    async *stream() {
      for (const r of rows) yield r
    },
  }
}

function driverWithoutStream(rows: Record<string, unknown>[]): Driver {
  return {
    async query() {
      return rows
    },
    async execute() {
      return { affected: rows.length }
    },
  }
}

const query = { sql: "SELECT 1", params: [] as readonly unknown[] }
const identity = <T>(rows: T[]): T[] => rows

describe("runStream — native path", () => {
  it("yields each row from Driver.stream in order", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const seen: Record<string, unknown>[] = []
    for await (const row of runStream(driverWithStream(rows), query, identity)) {
      seen.push(row)
    }
    expect(seen).toEqual(rows)
  })

  it("listener: start + end with rowCount = rows yielded", async () => {
    const events: QueryEvent[] = []
    const rows = [{ a: 1 }, { a: 2 }]
    for await (const _row of runStream(driverWithStream(rows), query, identity, undefined, (e) =>
      events.push(e),
    )) {
      // consume
      void _row
    }
    expect(events).toHaveLength(2)
    const [start, end] = events as [QueryEvent, QueryEvent]
    expect(start.phase).toBe("start")
    expect(start.id).toBe(end.id)
    expect(end.phase).toBe("end")
    if (end.phase === "end") expect(end.rowCount).toBe(2)
  })

  it("break mid-stream still emits end with the rows actually yielded", async () => {
    const events: QueryEvent[] = []
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]
    let count = 0
    for await (const _row of runStream(driverWithStream(rows), query, identity, undefined, (e) =>
      events.push(e),
    )) {
      count++
      if (count === 2) break
      void _row
    }
    expect(count).toBe(2)
    const end = events.find((e) => e.phase === "end")
    expect(end).toBeDefined()
    if (end?.phase === "end") expect(end.rowCount).toBe(2)
  })
})

describe("runStream — fallback path (driver has no stream())", () => {
  it("buffers via query() and yields one at a time", async () => {
    const rows = [{ id: 10 }, { id: 20 }]
    const seen: Record<string, unknown>[] = []
    for await (const row of runStream(driverWithoutStream(rows), query, identity)) {
      seen.push(row)
    }
    expect(seen).toEqual(rows)
  })

  it("listener: end.rowCount matches what came out of query()", async () => {
    const events: QueryEvent[] = []
    for await (const _row of runStream(
      driverWithoutStream([{ a: 1 }, { a: 2 }, { a: 3 }]),
      query,
      identity,
      undefined,
      (e) => events.push(e),
    )) {
      void _row
    }
    const end = events.find((e) => e.phase === "end")
    expect(end).toBeDefined()
    if (end?.phase === "end") expect(end.rowCount).toBe(3)
  })
})

describe("runStream — error propagation", () => {
  it("error event fires when the driver throws, original error rethrown", async () => {
    const events: QueryEvent[] = []
    const driver: Driver = {
      async query() {
        throw new Error("db down")
      },
      async execute() {
        return { affected: 0 }
      },
    }
    await expect(async () => {
      for await (const _row of runStream(driver, query, identity, undefined, (e) =>
        events.push(e),
      )) {
        void _row
      }
    }).rejects.toThrow("db down")
    expect(events.map((e) => e.phase)).toEqual(["start", "error"])
  })
})
