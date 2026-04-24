import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import type { QueryEvent } from "../../src/driver/types.ts"
import {
  combineListeners,
  createOtelListener,
  operationOf,
  OtelSpanStatusCode,
} from "../../src/otel.ts"
import type { OtelSpan, OtelTracer } from "../../src/otel.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

// A hand-rolled Tracer mock that records every span's lifecycle. Using
// the structural `OtelTracer` shim means we don't need @opentelemetry/api
// as a peer dep — tests just pass in an object with the right shape.

interface RecordedSpan {
  name: string
  attributes: Record<string, string | number | boolean>
  status: { code: number; message?: string } | null
  ended: boolean
  exception?: unknown
}

function mockTracer() {
  const spans: RecordedSpan[] = []
  const tracer: OtelTracer = {
    startSpan(name, options) {
      const span: RecordedSpan = {
        name,
        attributes: { ...(options?.attributes ?? {}) },
        status: null,
        ended: false,
      }
      spans.push(span)
      const api: OtelSpan = {
        setAttribute(key, value) {
          span.attributes[key] = value
        },
        setStatus(status) {
          span.status = status
        },
        recordException(err) {
          span.exception = err
        },
        end() {
          span.ended = true
        },
      }
      return api
    },
  }
  return { tracer, spans }
}

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS ot_users;
    CREATE TABLE ot_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO ot_users (name) VALUES ('A'), ('B');
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  ot_users: {
    id: serial().primaryKey(),
    name: text().notNull(),
  },
}

describe("createOtelListener", () => {
  it("emits a CLIENT span per query with db.system and db.operation", async () => {
    const { tracer, spans } = mockTracer()
    const onQuery = createOtelListener({ tracer, dbSystem: "postgresql" })
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery,
    })
    await db.selectFrom("ot_users").selectAll().many()

    expect(spans).toHaveLength(1)
    const [s] = spans
    expect(s!.name).toBe("SELECT postgresql")
    expect(s!.attributes["db.system"]).toBe("postgresql")
    expect(s!.attributes["db.operation"]).toBe("SELECT")
    expect(s!.attributes["db.sumak.kind"]).toBe("query")
    expect(s!.attributes["db.sumak.row_count"]).toBe(2)
    expect(s!.ended).toBe(true)
    expect(s!.status?.code).toBe(OtelSpanStatusCode.OK)
  })

  it("omits db.statement unless includeSql is set", async () => {
    const { tracer, spans } = mockTracer()
    const listener = createOtelListener({ tracer, dbSystem: "postgresql" })
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    await db.selectFrom("ot_users").selectAll().many()
    expect(spans[0]!.attributes["db.statement"]).toBeUndefined()
  })

  it("includeSql: true attaches db.statement", async () => {
    const { tracer, spans } = mockTracer()
    const listener = createOtelListener({
      tracer,
      dbSystem: "postgresql",
      includeSql: true,
    })
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    await db.selectFrom("ot_users").selectAll().many()
    expect(String(spans[0]!.attributes["db.statement"])).toMatch(/SELECT/)
  })

  it("error phase records exception and sets ERROR status", async () => {
    const { tracer, spans } = mockTracer()
    const listener = createOtelListener({ tracer, dbSystem: "postgresql" })
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    await expect(
      db.executeCompiled({ sql: "SELECT * FROM missing_table", params: [] }),
    ).rejects.toThrow()

    expect(spans).toHaveLength(1)
    const s = spans[0]!
    expect(s.ended).toBe(true)
    expect(s.exception).toBeDefined()
    expect(s.status?.code).toBe(OtelSpanStatusCode.ERROR)
  })

  it("transaction spans carry tx_phase and correlate by id", async () => {
    const { tracer, spans } = mockTracer()
    const listener = createOtelListener({ tracer, dbSystem: "postgresql" })
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: schema,
      onQuery: listener,
    })
    await db.transaction(async (tx) => {
      await tx.selectFrom("ot_users").selectAll().many()
    })

    // Exactly one tx-kind span (begin+end on same id) plus the inner SELECT.
    const txSpans = spans.filter((s) => s.attributes["db.sumak.kind"] === "transaction")
    expect(txSpans).toHaveLength(1)
    expect(txSpans[0]!.attributes["db.sumak.tx_phase"]).toBe("begin")
    expect(txSpans[0]!.ended).toBe(true)

    const selectSpans = spans.filter((s) => s.attributes["db.sumak.kind"] === "query")
    expect(selectSpans).toHaveLength(1)
    expect(selectSpans[0]!.ended).toBe(true)
  })

  it("no tracer call happens when onQuery sees end without a matching start", () => {
    // This is a stress-check: unusual event order can't crash.
    const { tracer, spans } = mockTracer()
    const listener = createOtelListener({ tracer })
    const fakeEnd: QueryEvent = {
      phase: "end",
      kind: "query",
      sql: "SELECT 1",
      params: [],
      id: 9999,
      durationMs: 1,
    }
    // Should not throw; no span to finalize.
    listener(fakeEnd)
    expect(spans).toHaveLength(0)
  })
})

describe("combineListeners", () => {
  it("calls each listener in order", () => {
    const log: string[] = []
    const a = (e: QueryEvent) => log.push(`a:${e.phase}`)
    const b = (e: QueryEvent) => log.push(`b:${e.phase}`)
    const combined = combineListeners(a, b)
    combined({
      phase: "start",
      kind: "query",
      sql: "X",
      params: [],
      id: 1,
    })
    expect(log).toEqual(["a:start", "b:start"])
  })

  it("swallows errors from individual listeners", () => {
    const log: string[] = []
    const bomb = (): void => {
      throw new Error("nope")
    }
    const b = (e: QueryEvent) => log.push(`b:${e.phase}`)
    const combined = combineListeners(bomb, b)
    combined({
      phase: "start",
      kind: "query",
      sql: "X",
      params: [],
      id: 1,
    })
    expect(log).toEqual(["b:start"]) // b still runs after bomb
  })
})

describe("operationOf", () => {
  const mk = (sql: string): QueryEvent => ({
    phase: "start",
    kind: "query",
    sql,
    params: [],
    id: 1,
  })

  it("extracts the leading keyword", () => {
    expect(operationOf(mk("SELECT 1"))).toBe("SELECT")
    expect(operationOf(mk("  insert into t"))).toBe("INSERT")
    expect(operationOf(mk("WITH cte AS (...)"))).toBe("WITH")
  })

  it("returns undefined for unknown keywords", () => {
    expect(operationOf(mk("FOOBAR tbl"))).toBeUndefined()
  })

  it("for transactions uses txPhase", () => {
    expect(
      operationOf({
        phase: "start",
        kind: "transaction",
        sql: "BEGIN",
        params: [],
        id: 1,
        txPhase: "begin",
      }),
    ).toBe("BEGIN")
  })
})
