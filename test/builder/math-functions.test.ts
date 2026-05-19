import { describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import {
  cos,
  degrees,
  exp,
  ln,
  log,
  pi,
  power,
  radians,
  sign,
  sin,
  sqrt,
  tan,
  val,
} from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { num } from "../../src/ns/num.ts"
import { numeric, real, serial } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  measurements: {
    id: serial().primaryKey(),
    x: real().notNull(),
    y: real().notNull(),
    angle: real().notNull(),
    amount: numeric().notNull(),
  },
}

const x = typedCol<number>("x")
const y = typedCol<number>("y")
const angle = typedCol<number>("angle")

// ─── power ───────────────────────────────────────────────────────────────

describe("power(base, exponent)", () => {
  it("emits POWER(base, exponent) on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ sq: power(x, val(2)) })
      .compile(db.printer())
    expect(q.sql).toContain(`POWER("x", 2)`)
  })

  it("emits POWER on MySQL with backtick identifiers", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ sq: power(x, val(2)) })
      .compile(db.printer())
    expect(q.sql).toContain("POWER(`x`, 2)")
  })

  it("emits POWER on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ sq: power(x, val(2)) })
      .compile(db.printer())
    expect(q.sql).toContain(`POWER("x", 2)`)
  })

  it("emits POWER on MSSQL", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ sq: power(x, val(2)) })
      .compile(db.printer())
    expect(q.sql).toContain(`POWER([x], 2)`)
  })

  it("composes with column references on both sides", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ r: power(x, y) })
      .compile(db.printer())
    expect(q.sql).toContain(`POWER("x", "y")`)
  })
})

// ─── sqrt ────────────────────────────────────────────────────────────────

describe("sqrt(expr)", () => {
  it.each([
    ["pg", pgDialect(), `SQRT("x")`] as const,
    ["mysql", mysqlDialect(), "SQRT(`x`)"] as const,
    ["sqlite", sqliteDialect(), `SQRT("x")`] as const,
    ["mssql", mssqlDialect(), `SQRT([x])`] as const,
  ])("emits SQRT on %s", (_name, dialect, expected) => {
    const db = sumak({ dialect, tables })
    const q = db
      .selectFrom("measurements")
      .select({ r: sqrt(x) })
      .compile(db.printer())
    expect(q.sql).toContain(expected)
  })
})

// ─── ln ──────────────────────────────────────────────────────────────────

describe("ln(expr)", () => {
  it("emits LN on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ l: ln(x) })
      .compile(db.printer())
    expect(q.sql).toContain(`LN("x")`)
  })

  it("emits LN on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ l: ln(x) })
      .compile(db.printer())
    expect(q.sql).toContain("LN(`x`)")
  })

  it("emits LN on SQLite (3.35+)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ l: ln(x) })
      .compile(db.printer())
    expect(q.sql).toContain(`LN("x")`)
  })

  it("rewrites LN(x) → LOG(x) on MSSQL (MSSQL's LOG is natural log)", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ l: ln(x) })
      .compile(db.printer())
    expect(q.sql).toContain(`LOG([x])`)
    // Critically: we should NOT emit a bare LN, which MSSQL rejects.
    expect(q.sql).not.toMatch(/\bLN\(/)
  })
})

// ─── log (base-10, normalised) ──────────────────────────────────────────

describe("log(expr) — base-10 across every dialect", () => {
  it("emits LOG on PG (LOG is base-10 natively)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ l: log(x) })
      .compile(db.printer())
    expect(q.sql).toContain(`LOG("x")`)
  })

  it("rewrites LOG(x) → LOG10(x) on MySQL (MySQL's LOG is natural log)", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ l: log(x) })
      .compile(db.printer())
    expect(q.sql).toContain("LOG10(`x`)")
    // Bare LOG would be the natural log on MySQL — that's wrong for `log()`.
    expect(q.sql).not.toMatch(/\bLOG\(`x`\)/)
  })

  it("rewrites LOG(x) → LOG10(x) on MSSQL (MSSQL's LOG is natural log)", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ l: log(x) })
      .compile(db.printer())
    expect(q.sql).toContain(`LOG10([x])`)
    expect(q.sql).not.toMatch(/\bLOG\([^1]/)
  })

  it("emits LOG on SQLite (3.35+ — LOG is base-10 natively)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ l: log(x) })
      .compile(db.printer())
    expect(q.sql).toContain(`LOG("x")`)
  })
})

// ─── exp ─────────────────────────────────────────────────────────────────

describe("exp(expr)", () => {
  it.each([
    ["pg", pgDialect(), `EXP("x")`] as const,
    ["mysql", mysqlDialect(), "EXP(`x`)"] as const,
    ["sqlite", sqliteDialect(), `EXP("x")`] as const,
    ["mssql", mssqlDialect(), `EXP([x])`] as const,
  ])("emits EXP on %s", (_name, dialect, expected) => {
    const db = sumak({ dialect, tables })
    const q = db
      .selectFrom("measurements")
      .select({ r: exp(x) })
      .compile(db.printer())
    expect(q.sql).toContain(expected)
  })
})

// ─── sign ────────────────────────────────────────────────────────────────

describe("sign(expr)", () => {
  it.each([
    ["pg", pgDialect(), `SIGN("x")`] as const,
    ["mysql", mysqlDialect(), "SIGN(`x`)"] as const,
    ["sqlite", sqliteDialect(), `SIGN("x")`] as const,
    ["mssql", mssqlDialect(), `SIGN([x])`] as const,
  ])("emits SIGN on %s", (_name, dialect, expected) => {
    const db = sumak({ dialect, tables })
    const q = db
      .selectFrom("measurements")
      .select({ r: sign(x) })
      .compile(db.printer())
    expect(q.sql).toContain(expected)
  })
})

// ─── pi ──────────────────────────────────────────────────────────────────

describe("pi()", () => {
  it("emits PI() on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db.selectFrom("measurements").select({ p: pi() }).compile(db.printer())
    expect(q.sql).toContain(`PI()`)
  })

  it("emits PI() on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db.selectFrom("measurements").select({ p: pi() }).compile(db.printer())
    expect(q.sql).toContain(`PI()`)
  })

  it("emits PI() on MSSQL", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db.selectFrom("measurements").select({ p: pi() }).compile(db.printer())
    expect(q.sql).toContain(`PI()`)
  })

  it("throws on SQLite (no built-in PI)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    expect(() => db.selectFrom("measurements").select({ p: pi() }).compile(db.printer())).toThrow(
      UnsupportedDialectFeatureError,
    )
  })
})

// ─── degrees / radians / sin / cos / tan ────────────────────────────────

describe("trigonometric and angle-conversion builders", () => {
  it.each([
    ["degrees", degrees, "DEGREES"] as const,
    ["radians", radians, "RADIANS"] as const,
    ["sin", sin, "SIN"] as const,
    ["cos", cos, "COS"] as const,
    ["tan", tan, "TAN"] as const,
  ])("emits %s on PG / MySQL / SQLite / MSSQL", (_name, fn, sqlName) => {
    for (const dialect of [pgDialect(), mysqlDialect(), sqliteDialect(), mssqlDialect()]) {
      const db = sumak({ dialect, tables })
      const q = db
        .selectFrom("measurements")
        .select({ r: fn(angle) })
        .compile(db.printer())
      expect(q.sql).toContain(`${sqlName}(`)
    }
  })

  it("sin(radians(degrees)) composes — angle-degree conversion idiom", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("measurements")
      .select({ y: sin(radians(angle)) })
      .compile(db.printer())
    expect(q.sql).toContain(`SIN(RADIANS("angle"))`)
  })
})

// ─── num namespace ───────────────────────────────────────────────────────

describe("num namespace exposes the math builders", () => {
  const db = sumak({ dialect: pgDialect(), tables })

  it("num.power / num.sqrt / num.ln / num.log / num.exp / num.sign", () => {
    const q = db
      .selectFrom("measurements")
      .select({
        a: num.power(x, val(2)),
        b: num.sqrt(x),
        c: num.ln(x),
        d: num.log(x),
        e: num.exp(x),
        f: num.sign(x),
      })
      .compile(db.printer())
    expect(q.sql).toContain(`POWER("x", 2)`)
    expect(q.sql).toContain(`SQRT("x")`)
    expect(q.sql).toContain(`LN("x")`)
    expect(q.sql).toContain(`LOG("x")`)
    expect(q.sql).toContain(`EXP("x")`)
    expect(q.sql).toContain(`SIGN("x")`)
  })

  it("num.pi / num.degrees / num.radians / num.sin / num.cos / num.tan", () => {
    const q = db
      .selectFrom("measurements")
      .select({
        p: num.pi(),
        d: num.degrees(angle),
        r: num.radians(angle),
        s: num.sin(angle),
        c: num.cos(angle),
        t: num.tan(angle),
      })
      .compile(db.printer())
    expect(q.sql).toContain(`PI()`)
    expect(q.sql).toContain(`DEGREES("angle")`)
    expect(q.sql).toContain(`RADIANS("angle")`)
    expect(q.sql).toContain(`SIN("angle")`)
    expect(q.sql).toContain(`COS("angle")`)
    expect(q.sql).toContain(`TAN("angle")`)
  })
})

// ─── Composition with the rest of the surface ───────────────────────────

describe("math builders compose with other expressions", () => {
  const db = sumak({ dialect: pgDialect(), tables })

  it("nests sqrt(power(x, 2)) inside a select projection", () => {
    const q = db
      .selectFrom("measurements")
      .select({ d: sqrt(power(x, val(2))) })
      .compile(db.printer())
    expect(q.sql).toContain(`SQRT(POWER("x", 2))`)
  })

  it("uppercases all of the math function names through STANDARD_FUNCTIONS", () => {
    const q = db
      .selectFrom("measurements")
      .select({ a: sqrt(x), b: exp(x), c: ln(x), d: log(x) })
      .compile(db.printer())
    expect(q.sql).toMatch(/SQRT\(/)
    expect(q.sql).toMatch(/EXP\(/)
    expect(q.sql).toMatch(/LN\(/)
    expect(q.sql).toMatch(/LOG\(/)
  })
})
