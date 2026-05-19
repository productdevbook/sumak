import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { percentileCont, percentileDisc, withinGroup } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that PERCENTILE_CONT / PERCENTILE_DISC with the
// SQL standard `WITHIN GROUP (ORDER BY …)` clause compile and return
// the values you'd expect for a known dataset.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS p_requests CASCADE;
    CREATE TABLE p_requests (
      id SERIAL PRIMARY KEY,
      region TEXT NOT NULL,
      response_ms INTEGER NOT NULL
    );
    INSERT INTO p_requests (region, response_ms) VALUES
      ('eu', 10), ('eu', 20), ('eu', 30), ('eu', 40), ('eu', 50),
      ('us', 100), ('us', 200), ('us', 300), ('us', 400), ('us', 500);
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  p_requests: {
    id: serial().primaryKey(),
    region: text().notNull(),
    response_ms: integer().notNull(),
  },
}

const responseMs = typedCol<number>("response_ms")

describe("PERCENTILE_CONT / PERCENTILE_DISC roundtrip via pglite", () => {
  it("PERCENTILE_CONT(0.5) returns the linear-interpolation median", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("p_requests")
      .select({
        p50: withinGroup(percentileCont(0.5), [{ expr: responseMs }]),
      })
      .many()
    expect(rows).toHaveLength(1)
    // Sorted set: [10, 20, 30, 40, 50, 100, 200, 300, 400, 500].
    // PERCENTILE_CONT(0.5) over 10 values interpolates between the
    // 5th (50) and 6th (100) values → 75.
    expect(Number(rows[0].p50)).toBeCloseTo(75, 6)
  })

  it("PERCENTILE_DISC(0.5) returns an actual dataset value (no interpolation)", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("p_requests")
      .select({
        p50: withinGroup(percentileDisc(0.5), [{ expr: responseMs }]),
      })
      .many()
    expect(rows).toHaveLength(1)
    // PERCENTILE_DISC at 0.5 over 10 values picks the 5th-smallest (50).
    expect(Number(rows[0].p50)).toBe(50)
  })

  it("GROUP BY region surfaces independent p50/p99 per region", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("p_requests")
      .select("region")
      .select({
        p50: withinGroup(percentileCont(0.5), [{ expr: responseMs }]),
        p99: withinGroup(percentileCont(0.99), [{ expr: responseMs }]),
      })
      .groupBy("region")
      .many()
    expect(rows).toHaveLength(2)
    const eu = rows.find((r) => r.region === "eu")
    const us = rows.find((r) => r.region === "us")
    expect(Number(eu?.p50)).toBeCloseTo(30, 6)
    expect(Number(us?.p50)).toBeCloseTo(300, 6)
    // p99 sits near the top of each region's distribution.
    expect(Number(eu?.p99)).toBeGreaterThan(49)
    expect(Number(us?.p99)).toBeGreaterThan(490)
  })
})
