import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import {
  avg,
  corr,
  covarPop,
  covarSamp,
  regrIntercept,
  regrR2,
  regrSlope,
  stddev,
  stddevPop,
  variance,
  variancePop,
} from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { real, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that the statistical-aggregate builders compile and
// return the values you'd expect on a deterministic dataset.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  // Dataset:
  //   x = 1..5, y = 2*x (perfect linear relationship, no noise)
  //   so:
  //     stddev_pop(x) = sqrt(2), stddev_samp(x) = sqrt(2.5)
  //     var_pop(x) = 2, var_samp(x) = 2.5
  //     corr(y, x) = 1.0 (perfect positive correlation)
  //     regr_slope(y, x) = 2.0
  //     regr_intercept(y, x) = 0.0
  //     regr_r2(y, x) = 1.0
  //     covar_pop(y, x) = 4.0, covar_samp(y, x) = 5.0
  await pg.exec(`
    DROP TABLE IF EXISTS stat_metrics CASCADE;
    CREATE TABLE stat_metrics (
      id SERIAL PRIMARY KEY,
      region TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL
    );
    INSERT INTO stat_metrics (region, x, y) VALUES
      ('eu', 1, 2),
      ('eu', 2, 4),
      ('eu', 3, 6),
      ('eu', 4, 8),
      ('eu', 5, 10);
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  stat_metrics: {
    id: serial().primaryKey(),
    region: text().notNull(),
    x: real().notNull(),
    y: real().notNull(),
  },
}

const x = typedCol<number>("x")
const y = typedCol<number>("y")

describe("Statistical aggregates roundtrip via pglite", () => {
  it("STDDEV / variance on a known linear dataset", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("stat_metrics")
      .select({
        a: avg(x),
        sP: stddevPop(x),
        sS: stddev(x),
        vP: variancePop(x),
        vS: variance(x),
      })
      .many()
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(Number(r.a)).toBeCloseTo(3, 6)
    // Population: sqrt(2) ≈ 1.41421356; sample: sqrt(2.5) ≈ 1.58113883
    expect(Number(r.sP)).toBeCloseTo(Math.sqrt(2), 5)
    expect(Number(r.sS)).toBeCloseTo(Math.sqrt(2.5), 5)
    expect(Number(r.vP)).toBeCloseTo(2, 6)
    expect(Number(r.vS)).toBeCloseTo(2.5, 6)
  })

  it("CORR / COVAR_* / REGR_* on a perfect linear relationship", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("stat_metrics")
      .select({
        c: corr(y, x),
        cP: covarPop(y, x),
        cS: covarSamp(y, x),
        m: regrSlope(y, x),
        b: regrIntercept(y, x),
        r2: regrR2(y, x),
      })
      .many()
    expect(rows).toHaveLength(1)
    const r = rows[0]
    // y = 2x exactly, so CORR = R² = 1, slope = 2, intercept = 0.
    expect(Number(r.c)).toBeCloseTo(1, 6)
    expect(Number(r.cP)).toBeCloseTo(4, 6)
    expect(Number(r.cS)).toBeCloseTo(5, 6)
    expect(Number(r.m)).toBeCloseTo(2, 6)
    expect(Number(r.b)).toBeCloseTo(0, 6)
    expect(Number(r.r2)).toBeCloseTo(1, 6)
  })
})
