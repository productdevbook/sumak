import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import type { QueryEvent } from "../../src/driver/types.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS oq_users;
    CREATE TABLE oq_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, age INT);
    INSERT INTO oq_users (name, age) VALUES ('Alice', 30), ('Bob', 25);
  `)
})

afterAll(async () => {
  await pg?.close()
})

function captureEvents() {
  const events: QueryEvent[] = []
  return {
    events,
    listener: (e: QueryEvent) => events.push(e),
  }
}

const schema = {
  oq_users: {
    id: serial().primaryKey(),
    name: text().notNull(),
    age: integer().nullable(),
  },
}

describe("SumakConfig.onQuery", () => {
  it("fires start + end around a SELECT with matching id and rowCount", async () => {
    const { events, listener } = captureEvents()
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    const rows = await db.selectFrom("oq_users").selectAll().many()
    expect(rows).toHaveLength(2)

    expect(events).toHaveLength(2)
    const [start, end] = events as [QueryEvent, QueryEvent]
    expect(start.phase).toBe("start")
    expect(start.kind).toBe("query")
    expect(start.sql).toMatch(/SELECT/)

    expect(end.phase).toBe("end")
    expect(end.kind).toBe("query")
    expect(end.id).toBe(start.id)
    if (end.phase === "end") {
      expect(end.rowCount).toBe(2)
      expect(end.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it("fires start + end around an UPDATE with `affected`", async () => {
    const { events, listener } = captureEvents()
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    await db
      .update("oq_users")
      .set({ age: 99 })
      .where(({ name }) => name.eq("Alice"))
      .exec()

    expect(events).toHaveLength(2)
    const end = events[1]
    expect(end?.phase).toBe("end")
    expect(end?.kind).toBe("execute")
    if (end?.phase === "end") {
      expect(end.affected).toBe(1)
    }
  })

  it("fires start + error when the driver rejects, with `error` populated", async () => {
    const { events, listener } = captureEvents()
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    await expect(
      db.executeCompiled({ sql: "SELECT * FROM missing_table", params: [] }),
    ).rejects.toThrow()

    expect(events).toHaveLength(2)
    const err = events[1]
    expect(err?.phase).toBe("error")
    if (err?.phase === "error") {
      expect(err.error).toBeInstanceOf(Error)
      expect(err.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it("listener errors are swallowed — a thrown listener does not break the query", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: () => {
        throw new Error("listener boom")
      },
    })
    // Query must still succeed; the listener failure is invisible.
    const rows = await db.selectFrom("oq_users").selectAll().many()
    expect(rows).toHaveLength(2)
  })

  it("transaction emits begin + commit events; child statements share no txPhase", async () => {
    const { events, listener } = captureEvents()
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    await db.transaction(async (tx) => {
      await tx.selectFrom("oq_users").selectAll().many()
    })

    const phases = events
      .filter((e) => e.kind === "transaction")
      .map((e) => [e.phase, e.txPhase] as const)
    expect(phases).toEqual([
      ["start", "begin"],
      ["end", "commit"],
    ])

    const child = events.find((e) => e.kind === "query" && e.phase === "start")
    expect(child).toBeDefined()
    expect(child?.txPhase).toBeUndefined()
  })

  it("transaction emits rollback event on throw", async () => {
    const { events, listener } = captureEvents()
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    await expect(
      db.transaction(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    const txEvents = events.filter((e) => e.kind === "transaction")
    expect(txEvents.map((e) => [e.phase, e.txPhase])).toEqual([
      ["start", "begin"],
      ["error", "rollback"],
    ])
  })

  it("no listener — zero overhead, no errors", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
    })
    const rows = await db.selectFrom("oq_users").selectAll().many()
    expect(rows).toHaveLength(2)
  })
})
