import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { bitAnd, bitOr, bitXor, boolAnd, boolOr } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { boolean, integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  flags: {
    id: serial().primaryKey(),
    region: text().notNull(),
    mask: integer().notNull(),
    passed: boolean().notNull(),
  },
}

const mask = typedCol<number>("mask")
const passed = typedCol<boolean>("passed")

// ─── BIT_AND / BIT_OR — happy path ────────────────────────────────────

describe("bitAnd(expr) — supported dialects", () => {
  it("emits BIT_AND on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ common: bitAnd(mask) })
      .compile(db.printer())
    expect(q.sql).toContain('BIT_AND("mask")')
    expect(q.sql).toContain('AS "common"')
  })

  it("emits BIT_AND on MySQL with backticks", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ common: bitAnd(mask) })
      .compile(db.printer())
    expect(q.sql).toContain("BIT_AND(`mask`)")
  })

  it("emits BIT_AND on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ common: bitAnd(mask) })
      .compile(db.printer())
    expect(q.sql).toContain('BIT_AND("mask")')
  })

  it("uppercases BIT_AND (STANDARD_FUNCTIONS path)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ common: bitAnd(mask) })
      .compile(db.printer())
    expect(q.sql).toMatch(/BIT_AND\(/)
    expect(q.sql).not.toMatch(/bit_and\(/)
  })

  it("composes with GROUP BY for per-region common-bits mask", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select("region")
      .select({ common: bitAnd(mask) })
      .groupBy("region")
      .compile(db.printer())
    expect(q.sql).toContain('GROUP BY "region"')
    expect(q.sql).toContain('BIT_AND("mask")')
  })

  it("rejects raw JS values — must wrap in val()/typedCol()", () => {
    expect(() => bitAnd(42 as any)).toThrow(TypeError)
  })
})

describe("bitOr(expr) — supported dialects", () => {
  it("emits BIT_OR on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ union: bitOr(mask) })
      .compile(db.printer())
    expect(q.sql).toContain('BIT_OR("mask")')
  })

  it("emits BIT_OR on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ u: bitOr(mask) })
      .compile(db.printer())
    expect(q.sql).toContain("BIT_OR(`mask`)")
  })

  it("emits BIT_OR on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ u: bitOr(mask) })
      .compile(db.printer())
    expect(q.sql).toContain('BIT_OR("mask")')
  })
})

// ─── BIT_AND / BIT_OR — MSSQL refusal ─────────────────────────────────

describe("BIT_AND / BIT_OR — MSSQL refusal", () => {
  // MSSQL has no `BIT_AND` / `BIT_OR` aggregates — T-SQL exposes only
  // the per-row bitwise operators (`&`, `|`, `^`), no multi-row reduction.
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("BIT_AND throws UnsupportedDialectFeatureError on MSSQL", () => {
    expect(() =>
      db
        .selectFrom("flags")
        .select({ common: bitAnd(mask) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("BIT_OR throws on MSSQL", () => {
    expect(() =>
      db
        .selectFrom("flags")
        .select({ u: bitOr(mask) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message names the BIT_AND / BIT_OR feature label", () => {
    try {
      db.selectFrom("flags")
        .select({ common: bitAnd(mask) })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("BIT_AND / BIT_OR")
    }
  })
})

// ─── BIT_XOR — MySQL only ─────────────────────────────────────────────

describe("bitXor(expr) — MySQL only", () => {
  it("emits BIT_XOR on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ parity: bitXor(mask) })
      .compile(db.printer())
    expect(q.sql).toContain("BIT_XOR(`mask`)")
  })

  it("throws on PG (matrix lists MySQL only — PG 14+ users can sqlFn)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    expect(() =>
      db
        .selectFrom("flags")
        .select({ parity: bitXor(mask) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("throws on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    expect(() =>
      db
        .selectFrom("flags")
        .select({ parity: bitXor(mask) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("throws on MSSQL", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    expect(() =>
      db
        .selectFrom("flags")
        .select({ parity: bitXor(mask) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── BOOL_AND / BOOL_OR — happy path ──────────────────────────────────

describe("boolAnd(expr) — supported dialects", () => {
  it("emits BOOL_AND on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ allPassed: boolAnd(passed) })
      .compile(db.printer())
    expect(q.sql).toContain('BOOL_AND("passed")')
    expect(q.sql).toContain('AS "allPassed"')
  })

  it("emits BOOL_AND on SQLite (3.45+)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ allPassed: boolAnd(passed) })
      .compile(db.printer())
    expect(q.sql).toContain('BOOL_AND("passed")')
  })

  it("composes with GROUP BY for per-region all-passed flag", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select("region")
      .select({ allPassed: boolAnd(passed) })
      .groupBy("region")
      .compile(db.printer())
    expect(q.sql).toContain('GROUP BY "region"')
    expect(q.sql).toContain('BOOL_AND("passed")')
  })
})

describe("boolOr(expr) — supported dialects", () => {
  it("emits BOOL_OR on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ anyPassed: boolOr(passed) })
      .compile(db.printer())
    expect(q.sql).toContain('BOOL_OR("passed")')
  })

  it("emits BOOL_OR on SQLite (3.45+)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select({ anyPassed: boolOr(passed) })
      .compile(db.printer())
    expect(q.sql).toContain('BOOL_OR("passed")')
  })
})

// ─── BOOL_AND / BOOL_OR — MySQL / MSSQL refusal ───────────────────────

describe("BOOL_AND / BOOL_OR — MySQL refusal", () => {
  // MySQL's `BIT_AND` / `BIT_OR` are bitwise, not boolean — no
  // BOOL_AND/BOOL_OR built-in. Workaround is MIN/MAX on the implicitly
  // coerced 0/1 TINYINT.
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("BOOL_AND throws on MySQL", () => {
    expect(() =>
      db
        .selectFrom("flags")
        .select({ allPassed: boolAnd(passed) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("BOOL_OR throws on MySQL", () => {
    expect(() =>
      db
        .selectFrom("flags")
        .select({ anyPassed: boolOr(passed) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message names the BOOL_AND / BOOL_OR feature label", () => {
    try {
      db.selectFrom("flags")
        .select({ allPassed: boolAnd(passed) })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("BOOL_AND / BOOL_OR")
    }
  })
})

describe("BOOL_AND / BOOL_OR — MSSQL refusal", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("BOOL_AND throws on MSSQL", () => {
    expect(() =>
      db
        .selectFrom("flags")
        .select({ allPassed: boolAnd(passed) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("BOOL_OR throws on MSSQL", () => {
    expect(() =>
      db
        .selectFrom("flags")
        .select({ anyPassed: boolOr(passed) })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── PGlite roundtrip — BIT_AND / BIT_OR / BOOL_AND / BOOL_OR ─────────

describe("BIT/BOOL aggregates — PGlite roundtrip", () => {
  let pglite: PGlite

  beforeAll(async () => {
    pglite = new PGlite()
    await pglite.exec(`
      CREATE TABLE flags (
        id SERIAL PRIMARY KEY,
        region TEXT NOT NULL,
        mask INTEGER NOT NULL,
        passed BOOLEAN NOT NULL
      );

      INSERT INTO flags (region, mask, passed) VALUES
        ('us', 0b0111, TRUE),
        ('us', 0b0101, TRUE),
        ('us', 0b1101, FALSE),
        ('eu', 0b1110, TRUE),
        ('eu', 0b1010, TRUE);
    `)
  })

  afterAll(async () => {
    await pglite.close()
  })

  it("BIT_AND folds to the common-bits mask per region", async () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select("region")
      .select({ common: bitAnd(mask) })
      .groupBy("region")
      .orderBy("region")
      .compile(db.printer())

    const result = await pglite.query<{ region: string; common: number }>(q.sql, q.params as any[])
    const byRegion = Object.fromEntries(result.rows.map((r) => [r.region, Number(r.common)]))
    // us: 0b0111 & 0b0101 & 0b1101 = 0b0101 = 5
    // eu: 0b1110 & 0b1010 = 0b1010 = 10
    expect(byRegion).toEqual({ us: 5, eu: 10 })
  })

  it("BIT_OR folds to the union-bits mask per region", async () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select("region")
      .select({ union_mask: bitOr(mask) })
      .groupBy("region")
      .orderBy("region")
      .compile(db.printer())

    const result = await pglite.query<{ region: string; union_mask: number }>(
      q.sql,
      q.params as any[],
    )
    const byRegion = Object.fromEntries(result.rows.map((r) => [r.region, Number(r.union_mask)]))
    // us: 0b0111 | 0b0101 | 0b1101 = 0b1111 = 15
    // eu: 0b1110 | 0b1010 = 0b1110 = 14
    expect(byRegion).toEqual({ us: 15, eu: 14 })
  })

  it("BOOL_AND returns TRUE iff every row passed", async () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select("region")
      .select({ allPassed: boolAnd(passed) })
      .groupBy("region")
      .orderBy("region")
      .compile(db.printer())

    const result = await pglite.query<{ region: string; allPassed: boolean }>(
      q.sql,
      q.params as any[],
    )
    const byRegion = Object.fromEntries(result.rows.map((r) => [r.region, r.allPassed]))
    // us: one row has passed=FALSE → BOOL_AND = FALSE
    // eu: both rows passed=TRUE → BOOL_AND = TRUE
    expect(byRegion).toEqual({ us: false, eu: true })
  })

  it("BOOL_OR returns TRUE iff at least one row passed", async () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("flags")
      .select("region")
      .select({ anyPassed: boolOr(passed) })
      .groupBy("region")
      .orderBy("region")
      .compile(db.printer())

    const result = await pglite.query<{ region: string; anyPassed: boolean }>(
      q.sql,
      q.params as any[],
    )
    const byRegion = Object.fromEntries(result.rows.map((r) => [r.region, r.anyPassed]))
    expect(byRegion).toEqual({ us: true, eu: true })
  })
})
