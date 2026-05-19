import { describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import {
  corr,
  covarPop,
  covarSamp,
  regrIntercept,
  regrR2,
  regrSlope,
  stddev,
  stddevPop,
  stddevSamp,
  variance,
  variancePop,
  varianceSamp,
} from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { integer, real, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  metrics: {
    id: serial().primaryKey(),
    region: text().notNull(),
    latency_ms: integer().notNull(),
    spend: real().notNull(),
    ctr: real().notNull(),
  },
}

const latency = typedCol<number>("latency_ms")
const ctr = typedCol<number>("ctr")
const spend = typedCol<number>("spend")

describe("Univariate statistical aggregates — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("stddev(expr) → STDDEV(expr)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ s: stddev(latency) })
      .compile(p)
    expect(q.sql).toContain('STDDEV("latency_ms")')
    expect(q.sql).toContain('AS "s"')
    expect(q.params).toEqual([])
  })

  it("stddevSamp(expr) → STDDEV_SAMP(expr) (explicit spelling)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ s: stddevSamp(latency) })
      .compile(p)
    expect(q.sql).toContain('STDDEV_SAMP("latency_ms")')
  })

  it("stddevPop(expr) → STDDEV_POP(expr)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ s: stddevPop(latency) })
      .compile(p)
    expect(q.sql).toContain('STDDEV_POP("latency_ms")')
  })

  it("variance(expr) → VARIANCE(expr)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ v: variance(latency) })
      .compile(p)
    expect(q.sql).toContain('VARIANCE("latency_ms")')
  })

  it("varianceSamp(expr) → VAR_SAMP(expr)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ v: varianceSamp(latency) })
      .compile(p)
    expect(q.sql).toContain('VAR_SAMP("latency_ms")')
  })

  it("variancePop(expr) → VAR_POP(expr)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ v: variancePop(latency) })
      .compile(p)
    expect(q.sql).toContain('VAR_POP("latency_ms")')
  })

  it("uppercases STDDEV in the emitted SQL (STANDARD_FUNCTIONS path)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ s: stddev(latency) })
      .compile(p)
    expect(q.sql).toMatch(/STDDEV\(/)
    expect(q.sql).not.toMatch(/stddev\(/)
  })

  it("rejects raw JS values — must wrap in val()/typedCol()", () => {
    expect(() => stddev(42 as any)).toThrow(TypeError)
    expect(() => variance(42 as any)).toThrow(TypeError)
  })

  it("composes with GROUP BY for per-region dispersion", () => {
    const q = db
      .selectFrom("metrics")
      .select("region")
      .select({
        jitter: stddev(latency),
        spread: variance(latency),
      })
      .groupBy("region")
      .compile(p)
    expect(q.sql).toContain('GROUP BY "region"')
    expect(q.sql).toContain('STDDEV("latency_ms")')
    expect(q.sql).toContain('VARIANCE("latency_ms")')
  })
})

describe("Univariate statistical aggregates — cross-dialect", () => {
  it("MySQL emits STDDEV(expr)", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("metrics")
      .select({ s: stddev(latency) })
      .compile(db.printer())
    expect(q.sql).toContain("STDDEV(`latency_ms`)")
  })

  it("SQLite emits STDDEV(expr)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("metrics")
      .select({ s: stddev(latency) })
      .compile(db.printer())
    expect(q.sql).toContain('STDDEV("latency_ms")')
  })

  it("MSSQL emits STDDEV(expr)", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("metrics")
      .select({ s: stddev(latency) })
      .compile(db.printer())
    expect(q.sql).toContain("STDDEV([latency_ms])")
  })

  it("MySQL emits VAR_POP(expr) with backtick quoting", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("metrics")
      .select({ v: variancePop(latency) })
      .compile(db.printer())
    expect(q.sql).toContain("VAR_POP(`latency_ms`)")
  })

  it("SQLite emits VAR_SAMP(expr) with double-quote quoting", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("metrics")
      .select({ v: varianceSamp(latency) })
      .compile(db.printer())
    expect(q.sql).toContain('VAR_SAMP("latency_ms")')
  })
})

describe("Linear-regression aggregates — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("corr(y, x) → CORR(y, x)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ r: corr(ctr, spend) })
      .compile(p)
    expect(q.sql).toContain('CORR("ctr", "spend")')
    expect(q.sql).toContain('AS "r"')
  })

  it("covarPop(y, x) → COVAR_POP(y, x)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ c: covarPop(ctr, spend) })
      .compile(p)
    expect(q.sql).toContain('COVAR_POP("ctr", "spend")')
  })

  it("covarSamp(y, x) → COVAR_SAMP(y, x)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ c: covarSamp(ctr, spend) })
      .compile(p)
    expect(q.sql).toContain('COVAR_SAMP("ctr", "spend")')
  })

  it("regrSlope(y, x) → REGR_SLOPE(y, x)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ m: regrSlope(ctr, spend) })
      .compile(p)
    expect(q.sql).toContain('REGR_SLOPE("ctr", "spend")')
  })

  it("regrIntercept(y, x) → REGR_INTERCEPT(y, x)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ b: regrIntercept(ctr, spend) })
      .compile(p)
    expect(q.sql).toContain('REGR_INTERCEPT("ctr", "spend")')
  })

  it("regrR2(y, x) → REGR_R2(y, x)", () => {
    const q = db
      .selectFrom("metrics")
      .select({ r2: regrR2(ctr, spend) })
      .compile(p)
    expect(q.sql).toContain('REGR_R2("ctr", "spend")')
  })

  it("argument order is preserved exactly (y first, x second)", () => {
    // Standard order is (dependent, independent). Swapping changes the
    // slope/intercept — make sure we don't silently flip them.
    const ySpend = db
      .selectFrom("metrics")
      .select({ m: regrSlope(spend, ctr) })
      .compile(p)
    expect(ySpend.sql).toContain('REGR_SLOPE("spend", "ctr")')
    const yCtr = db
      .selectFrom("metrics")
      .select({ m: regrSlope(ctr, spend) })
      .compile(p)
    expect(yCtr.sql).toContain('REGR_SLOPE("ctr", "spend")')
  })

  it("composes with GROUP BY for per-region regressions", () => {
    const q = db
      .selectFrom("metrics")
      .select("region")
      .select({ slope: regrSlope(ctr, spend), r2: regrR2(ctr, spend) })
      .groupBy("region")
      .compile(p)
    expect(q.sql).toContain('GROUP BY "region"')
    expect(q.sql).toContain('REGR_SLOPE("ctr", "spend")')
    expect(q.sql).toContain('REGR_R2("ctr", "spend")')
  })
})

describe("Linear-regression aggregates — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("emits CORR with MSSQL bracket quoting", () => {
    const q = db
      .selectFrom("metrics")
      .select({ r: corr(ctr, spend) })
      .compile(p)
    expect(q.sql).toContain("CORR([ctr], [spend])")
  })

  it("emits REGR_SLOPE with MSSQL bracket quoting", () => {
    const q = db
      .selectFrom("metrics")
      .select({ m: regrSlope(ctr, spend) })
      .compile(p)
    expect(q.sql).toContain("REGR_SLOPE([ctr], [spend])")
  })
})

describe("Linear-regression aggregates — MySQL refusal", () => {
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("CORR throws UnsupportedDialectFeatureError on MySQL", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ r: corr(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("COVAR_POP throws on MySQL", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ c: covarPop(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("COVAR_SAMP throws on MySQL", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ c: covarSamp(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("REGR_SLOPE throws on MySQL", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ m: regrSlope(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("REGR_INTERCEPT throws on MySQL", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ b: regrIntercept(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("REGR_R2 throws on MySQL", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ r2: regrR2(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message names the linear-regression feature label", () => {
    try {
      db.selectFrom("metrics")
        .select({ r: corr(ctr, spend) })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("linear-regression aggregates")
    }
  })

  it("univariate STDDEV / VARIANCE still pass through on MySQL", () => {
    const q = db
      .selectFrom("metrics")
      .select({ s: stddev(latency), v: variance(latency) })
      .compile(p)
    expect(q.sql).toContain("STDDEV(")
    expect(q.sql).toContain("VARIANCE(")
  })
})

describe("Linear-regression aggregates — SQLite refusal", () => {
  const db = sumak({ dialect: sqliteDialect(), tables })
  const p = db.printer()

  it("CORR throws UnsupportedDialectFeatureError on SQLite", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ r: corr(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("COVAR_POP throws on SQLite", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ c: covarPop(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("REGR_SLOPE throws on SQLite", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ m: regrSlope(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("REGR_R2 throws on SQLite", () => {
    expect(() =>
      db
        .selectFrom("metrics")
        .select({ r2: regrR2(ctr, spend) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("univariate STDDEV / VARIANCE still pass through on SQLite", () => {
    const q = db
      .selectFrom("metrics")
      .select({ s: stddev(latency), v: variance(latency) })
      .compile(p)
    expect(q.sql).toContain("STDDEV(")
    expect(q.sql).toContain("VARIANCE(")
  })
})
