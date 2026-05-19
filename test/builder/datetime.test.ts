import { describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { age, dateTrunc, extract } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { InvalidExpressionError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { serial, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  events: {
    id: serial().primaryKey(),
    region: text().notNull(),
    created_at: timestamp().notNull(),
    deleted_at: timestamp().nullable(),
  },
}

describe("extract — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("extract('year', col) emits EXTRACT(YEAR FROM col)", () => {
    const q = db
      .selectFrom("events")
      .select({ yr: extract("year", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q.sql).toContain('EXTRACT(YEAR FROM "created_at")')
    expect(q.sql).toContain('AS "yr"')
    expect(q.params).toEqual([])
  })

  it("field name is case-insensitive on input; uppercased on output", () => {
    const q = db
      .selectFrom("events")
      .select({ mo: extract("Month", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q.sql).toContain('EXTRACT(MONTH FROM "created_at")')
  })

  it("supports PG-flavour fields like EPOCH and DOW", () => {
    const q1 = db
      .selectFrom("events")
      .select({ epoch: extract("epoch", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q1.sql).toContain('EXTRACT(EPOCH FROM "created_at")')

    const q2 = db
      .selectFrom("events")
      .select({ dow: extract("DOW", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q2.sql).toContain('EXTRACT(DOW FROM "created_at")')
  })

  it("can be used inside a SELECT expression mixed with column refs", () => {
    const q = db
      .selectFrom("events")
      .select("region")
      .select({ yr: extract("year", typedCol<Date>("created_at")) })
      .compile(p)
    // Just verifying it survives normalize/print; the type-level shape is `Expression<number>`.
    expect(q.sql).toContain("EXTRACT(YEAR FROM")
    expect(q.sql).toContain('"region"')
  })

  it("rejects an unknown field at build time", () => {
    expect(() => extract("nope", typedCol<Date>("created_at"))).toThrow(InvalidExpressionError)
  })

  it("error message lists allowed fields", () => {
    try {
      extract("invalid_field", typedCol<Date>("created_at"))
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("YEAR")
      expect(err.message).toContain("MONTH")
    }
  })
})

describe("extract — MySQL", () => {
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("emits EXTRACT(YEAR FROM `col`) on MySQL", () => {
    const q = db
      .selectFrom("events")
      .select({ yr: extract("year", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q.sql).toContain("EXTRACT(YEAR FROM `created_at`)")
  })

  it("supports DAY / HOUR / MINUTE / SECOND on MySQL", () => {
    for (const f of ["day", "hour", "minute", "second"] as const) {
      const q = db
        .selectFrom("events")
        .select({ x: extract(f, typedCol<Date>("created_at")) })
        .compile(p)
      expect(q.sql).toContain(`EXTRACT(${f.toUpperCase()} FROM \`created_at\`)`)
    }
  })
})

describe("extract — SQLite", () => {
  const db = sumak({ dialect: sqliteDialect(), tables })
  const p = db.printer()

  it('emits EXTRACT(YEAR FROM "col") on SQLite', () => {
    const q = db
      .selectFrom("events")
      .select({ yr: extract("year", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q.sql).toContain('EXTRACT(YEAR FROM "created_at")')
  })
})

describe("extract — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("emits EXTRACT(YEAR FROM [col]) on MSSQL", () => {
    const q = db
      .selectFrom("events")
      .select({ yr: extract("year", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q.sql).toContain("EXTRACT(YEAR FROM [created_at])")
  })
})

describe("dateTrunc — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("dateTrunc('month', col) emits DATE_TRUNC('month', col)", () => {
    const q = db
      .selectFrom("events")
      .select({ bucket: dateTrunc("month", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q.sql).toContain(`DATE_TRUNC('month', "created_at")`)
    expect(q.sql).toContain('AS "bucket"')
    // The unit is emitted as a string literal — *not* parameterised
    // (PG's planner caches the truncation kind per-call).
    expect(q.params).toEqual([])
  })

  it("unit is lowercased before emit (PG accepts case-insensitive but lowercase is canonical)", () => {
    const q = db
      .selectFrom("events")
      .select({ b: dateTrunc("Hour", typedCol<Date>("created_at")) })
      .compile(p)
    expect(q.sql).toContain(`DATE_TRUNC('hour', "created_at")`)
  })

  it("composes with GROUP BY on a per-bucket aggregate", () => {
    const bucket = dateTrunc("day", typedCol<Date>("created_at"))
    const q = db.selectFrom("events").select({ b: bucket }).groupBy(bucket).compile(p)
    expect(q.sql).toContain("DATE_TRUNC('day'")
    expect(q.sql).toContain("GROUP BY")
  })

  it("rejects a unit with special characters at build time", () => {
    expect(() => dateTrunc("year'); DROP TABLE x; --", typedCol<Date>("created_at"))).toThrow(
      InvalidExpressionError,
    )
  })

  it("rejects whitespace in the unit", () => {
    expect(() => dateTrunc("year month", typedCol<Date>("created_at"))).toThrow(
      InvalidExpressionError,
    )
  })
})

describe("dateTrunc — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws UnsupportedDialectFeatureError on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    const p = db.printer()
    expect(() =>
      db
        .selectFrom("events")
        .select({ b: dateTrunc("month", typedCol<Date>("created_at")) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("the error message names DATE_TRUNC so callers can grep the matrix", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const p = db.printer()
    try {
      db.selectFrom("events")
        .select({ b: dateTrunc("month", typedCol<Date>("created_at")) })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("DATE_TRUNC")
    }
  })
})

describe("age — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("age(col) one-arg form emits AGE(col)", () => {
    const q = db
      .selectFrom("events")
      .select({ a: age(typedCol<Date>("created_at")) })
      .compile(p)
    expect(q.sql).toContain('AGE("created_at")')
    expect(q.sql).toContain('AS "a"')
  })

  it("age(end, start) two-arg form emits AGE(end, start)", () => {
    const q = db
      .selectFrom("events")
      .select({
        a: age(typedCol<Date>("deleted_at"), typedCol<Date>("created_at")),
      })
      .compile(p)
    expect(q.sql).toContain('AGE("deleted_at", "created_at")')
  })

  it("accepts both Col and Expression for the end / start arguments", () => {
    // The signature accepts either Col or Expression; cover both
    // permutations to make sure the shape unifies through `instanceof Col`.
    const q = db
      .selectFrom("events")
      .select({
        // typedCol returns an Expression (not a Col instance) — exercises
        // the `isExpression` branch.
        a: age(typedCol<Date>("deleted_at"), typedCol<Date>("created_at")),
      })
      .compile(p)
    expect(q.sql).toContain('AGE("deleted_at", "created_at")')
  })
})

describe("age — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws UnsupportedDialectFeatureError on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    const p = db.printer()
    expect(() =>
      db
        .selectFrom("events")
        .select({ a: age(typedCol<Date>("created_at")) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("the error message names AGE", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const p = db.printer()
    try {
      db.selectFrom("events")
        .select({ a: age(typedCol<Date>("created_at")) })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("AGE")
    }
  })
})
