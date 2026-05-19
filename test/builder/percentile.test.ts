import { describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { percentileCont, percentileDisc, val, withinGroup } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  requests: {
    id: serial().primaryKey(),
    region: text().notNull(),
    response_ms: integer().notNull(),
  },
}

const responseMs = typedCol<number>("response_ms")

describe("PERCENTILE_CONT / PERCENTILE_DISC — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_ms)", () => {
    const q = db
      .selectFrom("requests")
      .select({
        p50: withinGroup(percentileCont(0.5), [{ expr: responseMs }]),
      })
      .compile(p)
    // Fraction is a numeric literal — printer inlines it (matches what
    // a human would write; PG's planner caches the plan either way).
    expect(q.sql).toContain("PERCENTILE_CONT(0.5)")
    expect(q.sql).toContain('WITHIN GROUP (ORDER BY "response_ms" ASC)')
    expect(q.sql).toContain('AS "p50"')
    expect(q.params).toEqual([])
  })

  it("PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY response_ms)", () => {
    const q = db
      .selectFrom("requests")
      .select({
        p99: withinGroup(percentileDisc(0.99), [{ expr: responseMs }]),
      })
      .compile(p)
    expect(q.sql).toContain("PERCENTILE_DISC(0.99)")
    expect(q.sql).toContain('WITHIN GROUP (ORDER BY "response_ms" ASC)')
    expect(q.sql).toContain('AS "p99"')
    expect(q.params).toEqual([])
  })

  it("supports DESC direction in the WITHIN GROUP order list", () => {
    const q = db
      .selectFrom("requests")
      .select({
        p50: withinGroup(percentileCont(0.5), [{ expr: responseMs, direction: "DESC" }]),
      })
      .compile(p)
    expect(q.sql).toContain('WITHIN GROUP (ORDER BY "response_ms" DESC)')
  })

  it("composes with GROUP BY for per-region percentiles", () => {
    const q = db
      .selectFrom("requests")
      .select("region")
      .select({
        p50: withinGroup(percentileCont(0.5), [{ expr: responseMs }]),
      })
      .groupBy("region")
      .compile(p)
    expect(q.sql).toContain('"region"')
    expect(q.sql).toContain("PERCENTILE_CONT(0.5)")
    expect(q.sql).toContain("WITHIN GROUP (ORDER BY")
    expect(q.sql).toContain("GROUP BY")
  })

  it("dashboard p50/p95/p99 — multiple percentiles in one SELECT", () => {
    const q = db
      .selectFrom("requests")
      .select({
        p50: withinGroup(percentileCont(0.5), [{ expr: responseMs }]),
        p95: withinGroup(percentileCont(0.95), [{ expr: responseMs }]),
        p99: withinGroup(percentileCont(0.99), [{ expr: responseMs }]),
      })
      .compile(p)
    expect(q.sql).toContain('AS "p50"')
    expect(q.sql).toContain('AS "p95"')
    expect(q.sql).toContain('AS "p99"')
    // Three PERCENTILE_CONT calls — each with its own inlined fraction.
    const occurrences = q.sql.match(/PERCENTILE_CONT/g)
    expect(occurrences).toHaveLength(3)
    expect(q.sql).toContain("PERCENTILE_CONT(0.5)")
    expect(q.sql).toContain("PERCENTILE_CONT(0.95)")
    expect(q.sql).toContain("PERCENTILE_CONT(0.99)")
  })

  it("percentileCont without withinGroup still compiles (caller error surfaces at PG)", () => {
    // The builder doesn't force pairing — we mirror PG's grammar
    // rather than invent a stricter API. A bare PERCENTILE_CONT(0.5)
    // is technically grammatical SQL; PG rejects it semantically.
    const q = db
      .selectFrom("requests")
      .select({ p: percentileCont(0.5) as any })
      .compile(p)
    expect(q.sql).toContain("PERCENTILE_CONT(0.5)")
    expect(q.sql).not.toContain("WITHIN GROUP")
  })
})

describe("PERCENTILE_CONT / PERCENTILE_DISC — MySQL", () => {
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("emits standard syntax on MySQL", () => {
    const q = db
      .selectFrom("requests")
      .select({
        p50: withinGroup(percentileCont(0.5), [{ expr: responseMs }]),
      })
      .compile(p)
    expect(q.sql).toContain("PERCENTILE_CONT(0.5)")
    expect(q.sql).toContain("WITHIN GROUP (ORDER BY `response_ms` ASC)")
  })
})

describe("PERCENTILE_CONT / PERCENTILE_DISC — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("emits standard syntax on MSSQL", () => {
    const q = db
      .selectFrom("requests")
      .select({
        p50: withinGroup(percentileDisc(0.5), [{ expr: responseMs }]),
      })
      .compile(p)
    expect(q.sql).toContain("PERCENTILE_DISC(0.5)")
    expect(q.sql).toContain("WITHIN GROUP (ORDER BY [response_ms] ASC)")
  })
})

describe("PERCENTILE_CONT / PERCENTILE_DISC — SQLite", () => {
  const db = sumak({ dialect: sqliteDialect(), tables })
  const p = db.printer()

  it("throws UnsupportedDialectFeatureError on SQLite when WITHIN GROUP is used", () => {
    expect(() =>
      db
        .selectFrom("requests")
        .select({
          p50: withinGroup(percentileCont(0.5), [{ expr: responseMs }]),
        })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message names the feature so callers can grep the matrix", () => {
    try {
      db.selectFrom("requests")
        .select({
          p: withinGroup(percentileCont(0.5), [{ expr: responseMs }]),
        })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("ordered-set aggregates")
    }
  })

  it("bare PERCENTILE_CONT (no withinGroup) does not trigger the feature guard", () => {
    // SQLite's printer only refuses the WITHIN GROUP clause. A bare
    // PERCENTILE_CONT(0.5) is allowed through (SQLite will reject at
    // runtime as an unknown function — that's the caller's signal).
    const q = db
      .selectFrom("requests")
      .select({ p: percentileCont(0.5) as any })
      .compile(p)
    expect(q.sql).toContain("PERCENTILE_CONT(0.5)")
  })
})

describe("withinGroup composition — independent of percentile helpers", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("MODE() WITHIN GROUP (ORDER BY …) — composable on any function", () => {
    // `withinGroup` only attaches the AST clause; it doesn't validate
    // the function name. That keeps the door open for MODE, RANK
    // ordered-set forms, future custom UDF-based ordered aggregates.
    const mode = withinGroup(
      // unsafe-but-typed handle to a bare MODE() call
      { node: { type: "function_call", name: "MODE", args: [] } } as any,
      [{ expr: val(1) as any }],
    )
    const q = db
      .selectFrom("requests")
      .select({ m: mode as any })
      .compile(p)
    expect(q.sql).toContain("MODE() WITHIN GROUP (ORDER BY")
  })
})
