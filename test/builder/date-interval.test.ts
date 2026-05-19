import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { dateAdd, dateSub } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { InvalidExpressionError } from "../../src/errors.ts"
import { serial, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  events: {
    id: serial().primaryKey(),
    region: text().notNull(),
    created_at: timestamp().notNull(),
    expires_at: timestamp().nullable(),
  },
}

describe("dateAdd — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("dateAdd(col, 7, 'day') emits expr + INTERVAL '7 days'", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateAdd(typedCol<Date>("created_at"), 7, "day") })
      .compile(p)
    expect(q.sql).toContain(`("created_at" + INTERVAL '7 days')`)
    expect(q.sql).toContain('AS "shifted"')
    // The amount is embedded as a literal, not parameterised — PG (and
    // every other engine) caches plans by the literal interval.
    expect(q.params).toEqual([])
  })

  it("supports every supported unit", () => {
    for (const unit of ["year", "month", "week", "day", "hour", "minute", "second"] as const) {
      const q = db
        .selectFrom("events")
        .select({ x: dateAdd(typedCol<Date>("created_at"), 1, unit) })
        .compile(p)
      expect(q.sql).toContain(`INTERVAL '1 ${unit}s'`)
    }
  })

  it("negative amount via dateAdd emits `- INTERVAL`", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateAdd(typedCol<Date>("created_at"), -7, "day") })
      .compile(p)
    expect(q.sql).toContain(`("created_at" - INTERVAL '7 days')`)
  })

  it("rejects a non-integer amount at build time", () => {
    expect(() => dateAdd(typedCol<Date>("created_at"), 1.5, "day")).toThrow(InvalidExpressionError)
  })

  it("rejects NaN / Infinity at build time", () => {
    expect(() => dateAdd(typedCol<Date>("created_at"), Number.NaN, "day")).toThrow(
      InvalidExpressionError,
    )
    expect(() => dateAdd(typedCol<Date>("created_at"), Number.POSITIVE_INFINITY, "day")).toThrow(
      InvalidExpressionError,
    )
  })

  it("rejects an unknown unit at build time", () => {
    expect(() => dateAdd(typedCol<Date>("created_at"), 1, "century" as unknown as "year")).toThrow(
      InvalidExpressionError,
    )
  })
})

describe("dateSub — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("dateSub(col, 7, 'day') emits expr - INTERVAL '7 days'", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateSub(typedCol<Date>("created_at"), 7, "day") })
      .compile(p)
    expect(q.sql).toContain(`("created_at" - INTERVAL '7 days')`)
  })

  it("dateSub with a negative amount adds back (symmetric with dateAdd(-n))", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateSub(typedCol<Date>("created_at"), -3, "month") })
      .compile(p)
    // dateSub negates the amount internally; -(-3) = +3 → `+ INTERVAL '3 months'`
    expect(q.sql).toContain(`("created_at" + INTERVAL '3 months')`)
  })
})

describe("dateAdd / dateSub — MySQL", () => {
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("dateAdd emits DATE_ADD(col, INTERVAL N UNIT)", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateAdd(typedCol<Date>("created_at"), 7, "day") })
      .compile(p)
    expect(q.sql).toContain("DATE_ADD(`created_at`, INTERVAL 7 DAY)")
  })

  it("dateSub emits DATE_SUB(col, INTERVAL N UNIT)", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateSub(typedCol<Date>("created_at"), 7, "day") })
      .compile(p)
    expect(q.sql).toContain("DATE_SUB(`created_at`, INTERVAL 7 DAY)")
  })

  it("unit is uppercased and singular per MySQL grammar", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateAdd(typedCol<Date>("created_at"), 1, "month") })
      .compile(p)
    expect(q.sql).toContain("INTERVAL 1 MONTH")
    expect(q.sql).not.toContain("MONTHS")
  })

  it("negative dateAdd flips to DATE_SUB for readability", () => {
    // dateAdd(-7) on MySQL chooses DATE_SUB(7) so the SQL reads
    // naturally. Both forms are semantically equivalent.
    const q = db
      .selectFrom("events")
      .select({ shifted: dateAdd(typedCol<Date>("created_at"), -5, "hour") })
      .compile(p)
    expect(q.sql).toContain("DATE_SUB(`created_at`, INTERVAL 5 HOUR)")
  })
})

describe("dateAdd / dateSub — SQLite", () => {
  const db = sumak({ dialect: sqliteDialect(), tables })
  const p = db.printer()

  it("dateAdd emits datetime(col, '+N units')", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateAdd(typedCol<Date>("created_at"), 7, "day") })
      .compile(p)
    expect(q.sql).toContain(`datetime("created_at", '+7 days')`)
  })

  it("dateSub emits datetime(col, '-N units')", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateSub(typedCol<Date>("created_at"), 3, "month") })
      .compile(p)
    expect(q.sql).toContain(`datetime("created_at", '-3 months')`)
  })
})

describe("dateAdd / dateSub — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("dateAdd emits DATEADD(unit, N, col)", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateAdd(typedCol<Date>("created_at"), 7, "day") })
      .compile(p)
    expect(q.sql).toContain("DATEADD(day, 7, [created_at])")
  })

  it("dateSub emits DATEADD with a negative number (T-SQL has no DATESUB)", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateSub(typedCol<Date>("created_at"), 3, "month") })
      .compile(p)
    expect(q.sql).toContain("DATEADD(month, -3, [created_at])")
  })

  it("unit is the bare identifier — no quoting", () => {
    const q = db
      .selectFrom("events")
      .select({ shifted: dateAdd(typedCol<Date>("created_at"), 2, "year") })
      .compile(p)
    expect(q.sql).toContain("DATEADD(year, 2,")
    expect(q.sql).not.toContain("DATEADD('year'")
  })
})

describe("dateAdd / dateSub — composition", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("can appear inside a WHERE comparison", () => {
    const q = db
      .selectFrom("events")
      .selectAll()
      .where(({ created_at }) => created_at.lt(dateAdd(typedCol<Date>("expires_at"), -7, "day")))
      .compile(p)
    expect(q.sql).toContain("WHERE")
    expect(q.sql).toContain(`("expires_at" - INTERVAL '7 days')`)
  })
})

// ── PGlite roundtrip — verifies the emitted SQL actually executes ──

const pgDb = sumak({
  dialect: pgDialect(),
  tables: {
    moments: {
      id: serial().primaryKey(),
      ts: timestamp().notNull(),
    },
  },
})
const pgPrinter = pgDb.printer()

let pglite: PGlite

beforeAll(async () => {
  pglite = new PGlite()
  await pglite.exec(`
    CREATE TABLE moments (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL
    );
    INSERT INTO moments (ts) VALUES ('2026-01-01 00:00:00');
  `)
})

afterAll(async () => {
  await pglite.close()
})

describe("dateAdd — PGlite roundtrip", () => {
  // PGlite returns `timestamp without time zone` values as JS `Date`
  // objects parsed in the local zone — the wall-clock components are
  // what we want to assert here, not UTC, since the source column has
  // no zone attached.
  function wallClock(d: Date): { y: number; mo: number; da: number; h: number } {
    return {
      y: d.getFullYear(),
      mo: d.getMonth(),
      da: d.getDate(),
      h: d.getHours(),
    }
  }

  it("adding 7 days to 2026-01-01 yields 2026-01-08", async () => {
    const q = pgDb
      .selectFrom("moments")
      .select({ shifted: dateAdd(typedCol<Date>("ts"), 7, "day") })
      .where(({ id }) => id.eq(1))
      .compile(pgPrinter)
    const result = await pglite.query<{ shifted: unknown }>(q.sql, q.params as unknown[])
    expect(result.rows.length).toBe(1)
    const shifted = new Date(result.rows[0]!.shifted as string | Date)
    const wc = wallClock(shifted)
    expect(wc.y).toBe(2026)
    expect(wc.mo).toBe(0) // January is 0
    expect(wc.da).toBe(8)
  })

  it("subtracting 1 month from 2026-01-01 yields 2025-12-01", async () => {
    const q = pgDb
      .selectFrom("moments")
      .select({ shifted: dateSub(typedCol<Date>("ts"), 1, "month") })
      .where(({ id }) => id.eq(1))
      .compile(pgPrinter)
    const result = await pglite.query<{ shifted: unknown }>(q.sql, q.params as unknown[])
    expect(result.rows.length).toBe(1)
    const shifted = new Date(result.rows[0]!.shifted as string | Date)
    const wc = wallClock(shifted)
    expect(wc.y).toBe(2025)
    expect(wc.mo).toBe(11) // December is 11
    expect(wc.da).toBe(1)
  })

  it("adding hours composes with the timestamp's time-of-day", async () => {
    const q = pgDb
      .selectFrom("moments")
      .select({ shifted: dateAdd(typedCol<Date>("ts"), 5, "hour") })
      .where(({ id }) => id.eq(1))
      .compile(pgPrinter)
    const result = await pglite.query<{ shifted: unknown }>(q.sql, q.params as unknown[])
    expect(result.rows.length).toBe(1)
    const shifted = new Date(result.rows[0]!.shifted as string | Date)
    const wc = wallClock(shifted)
    // 2026-01-01 00:00 + 5h = 2026-01-01 05:00 wall-clock
    expect(wc.h).toBe(5)
    expect(wc.da).toBe(1)
  })
})
