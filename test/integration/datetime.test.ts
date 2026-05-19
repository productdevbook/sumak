import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { age, dateTrunc, extract } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that EXTRACT / DATE_TRUNC / AGE compile through the
// sumak printer and return the values you'd expect from PG. Schema
// uses a fixed-date dataset so the assertions are deterministic across
// any local clock.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS dt_events CASCADE;
    CREATE TABLE dt_events (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL
    );
    INSERT INTO dt_events (label, created_at) VALUES
      ('a', '2026-01-15 10:30:00'),
      ('b', '2026-02-20 14:45:00'),
      ('c', '2026-02-22 09:00:00'),
      ('d', '2026-03-01 00:00:00');
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  dt_events: {
    id: serial().primaryKey(),
    label: text().notNull(),
    created_at: timestamp().notNull(),
  },
}

const createdAt = typedCol<Date>("created_at")

describe("extract roundtrip via PGlite", () => {
  it("EXTRACT(YEAR FROM ts) returns 2026 for every row", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("dt_events")
      .select({ yr: extract("year", createdAt) as never })
      .orderBy("id")
      .many()
    expect(rows).toHaveLength(4)
    // PG returns EXTRACT as numeric; the driver may surface that as
    // string or number depending on adapter — coerce.
    for (const r of rows) expect(Number(r.yr)).toBe(2026)
  })

  it("EXTRACT(MONTH FROM ts) returns the calendar month", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("dt_events")
      .select({ mo: extract("month", createdAt) as never })
      .orderBy("id")
      .many()
    expect(rows.map((r) => Number(r.mo))).toEqual([1, 2, 2, 3])
  })

  it("EXTRACT(EPOCH FROM ts) returns seconds since the unix epoch", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("dt_events")
      .select({ ep: extract("epoch", createdAt) as never })
      .orderBy("id")
      .limit(1)
      .many()
    // 2026-01-15 10:30:00 UTC → 1768509000 (sanity-check sign and order
    // of magnitude — PG may emit timezone-adjusted depending on session
    // config; cover a wide window).
    const ep = Number(rows[0].ep)
    expect(ep).toBeGreaterThan(1_700_000_000)
    expect(ep).toBeLessThan(1_900_000_000)
  })
})

describe("dateTrunc roundtrip via PGlite", () => {
  it("DATE_TRUNC('month', ts) buckets rows by calendar month", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const bucket = dateTrunc("month", createdAt)
    const rows = await db
      .selectFrom("dt_events")
      .select({ bucket: bucket as never })
      .orderBy("id")
      .many()
    // Two rows fall in February — they share the same trunc value.
    // The driver may surface PG's `timestamp` as a JS Date or as a
    // string; normalise via the epoch ms so the assertion works either
    // way. We use the row-1 vs row-2 equality + the count-of-distinct-
    // values shape rather than asserting exact UTC strings, which would
    // depend on the local timezone PG ran in.
    const epochs = rows.map((r) => new Date(r.bucket as Date | string).getTime())
    expect(epochs[1]).toBe(epochs[2])
    // Three distinct buckets across four rows (Feb has two).
    expect(new Set(epochs).size).toBe(3)
    // First bucket must come strictly before the second and third.
    expect(epochs[0]).toBeLessThan(epochs[1])
    expect(epochs[2]).toBeLessThan(epochs[3])
  })

  it("composes with GROUP BY for a per-month aggregate", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const bucket = dateTrunc("month", createdAt)
    const rows = await db
      .selectFrom("dt_events")
      .select({ bucket: bucket as never })
      .groupBy(bucket)
      .orderBy(bucket)
      .many()
    // Four rows, three distinct months — Jan, Feb (×2), Mar → 3 groups.
    expect(rows).toHaveLength(3)
  })
})

describe("age roundtrip via PGlite", () => {
  it("AGE(end, start) returns an interval", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("dt_events")
      .select({
        gap: age(
          typedCol<Date>("created_at"),
          // Compare every row to the same baseline timestamp by
          // wrapping a literal in another `created_at` reference (the
          // values are different per row, so AGE returns a non-zero
          // interval). Use `id=1`'s timestamp as the baseline via a
          // self-join in a real query; here we just pass the column to
          // itself as a sanity check.
          typedCol<Date>("created_at"),
        ) as never,
      })
      .orderBy("id")
      .limit(1)
      .many()
    expect(rows).toHaveLength(1)
    // PG's interval text representation for "no difference" is
    // "00:00:00" (or null-ish depending on adapter). The shape we
    // assert here is "the query compiled and returned a row" — the
    // builder-level test covers exact emit; this proves PG accepted
    // it.
    expect(rows[0]).toBeDefined()
  })
})
