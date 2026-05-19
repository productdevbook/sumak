import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { firstValue, lastValue, nthValue, over } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { win } from "../../src/ns/win.ts"
import { integer, real, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  ticks: {
    id: serial().primaryKey(),
    symbol: text().notNull(),
    ts: integer().notNull(),
    price: real().notNull(),
  },
}

const price = typedCol<number>("price")

// ─── firstValue — all four dialects ───────────────────────────────────

describe("firstValue(expr)", () => {
  it("emits FIRST_VALUE(...) OVER (...) on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        opening: over(firstValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain('FIRST_VALUE("price") OVER')
    expect(q.sql).toContain('PARTITION BY "symbol"')
    expect(q.sql).toContain('ORDER BY "ts"')
  })

  it("emits FIRST_VALUE(...) OVER (...) on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        opening: over(firstValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain("FIRST_VALUE(`price`) OVER")
  })

  it("emits FIRST_VALUE(...) OVER (...) on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        opening: over(firstValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain('FIRST_VALUE("price") OVER')
  })

  it("emits FIRST_VALUE(...) OVER (...) on MSSQL", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        opening: over(firstValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain("FIRST_VALUE([price]) OVER")
  })

  it("bare firstValue() without over() throws at print time", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    expect(() =>
      db
        .selectFrom("ticks")
        .select({ opening: firstValue(price) })
        .compile(db.printer()),
    ).toThrow(/FIRST_VALUE is a window function/)
  })

  it("rejects raw JS values — must wrap in val()/typedCol()", () => {
    expect(() => firstValue(42 as any)).toThrow(TypeError)
  })
})

// ─── lastValue — all four dialects ────────────────────────────────────

describe("lastValue(expr)", () => {
  it("emits LAST_VALUE(...) OVER (...) on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        closing: over(lastValue(price), (w) =>
          w
            .partitionBy("symbol")
            .orderBy("ts")
            .rows({ type: "unbounded_preceding" }, { type: "unbounded_following" }),
        ),
      })
      .compile(db.printer())
    expect(q.sql).toContain('LAST_VALUE("price") OVER')
    expect(q.sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING")
  })

  it("emits LAST_VALUE(...) OVER (...) on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        closing: over(lastValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain("LAST_VALUE(`price`) OVER")
  })

  it("emits LAST_VALUE(...) OVER (...) on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        closing: over(lastValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain('LAST_VALUE("price") OVER')
  })

  it("emits LAST_VALUE(...) OVER (...) on MSSQL", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        closing: over(lastValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain("LAST_VALUE([price]) OVER")
  })

  it("bare lastValue() without over() throws at print time", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    expect(() =>
      db
        .selectFrom("ticks")
        .select({ closing: lastValue(price) })
        .compile(db.printer()),
    ).toThrow(/LAST_VALUE is a window function/)
  })
})

// ─── nthValue — PG / MySQL / SQLite; MSSQL refusal ────────────────────

describe("nthValue(expr, n)", () => {
  it("emits NTH_VALUE(expr, n) OVER (...) on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        third: over(nthValue(price, 3), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain('NTH_VALUE("price", 3) OVER')
  })

  it("emits NTH_VALUE on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        third: over(nthValue(price, 3), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain("NTH_VALUE(`price`, 3) OVER")
  })

  it("emits NTH_VALUE on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select({
        third: over(nthValue(price, 3), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(q.sql).toContain('NTH_VALUE("price", 3) OVER')
  })

  it("throws on MSSQL (NTH_VALUE has no T-SQL equivalent)", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    expect(() =>
      db
        .selectFrom("ticks")
        .select({
          third: over(nthValue(price, 3), (w) => w.partitionBy("symbol").orderBy("ts")),
        })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message on MSSQL names the NTH_VALUE feature label", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    try {
      db.selectFrom("ticks")
        .select({
          third: over(nthValue(price, 3), (w) => w.partitionBy("symbol").orderBy("ts")),
        })
        .compile(db.printer())
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("NTH_VALUE")
    }
  })

  it("bare nthValue() without over() throws at print time", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    expect(() =>
      db
        .selectFrom("ticks")
        .select({ third: nthValue(price, 3) })
        .compile(db.printer()),
    ).toThrow(/NTH_VALUE is a window function/)
  })

  it("rejects raw JS values for expr", () => {
    expect(() => nthValue(42 as any, 3)).toThrow(TypeError)
  })
})

// ─── win namespace mirror ─────────────────────────────────────────────

describe("win namespace", () => {
  it("exposes firstValue, lastValue, nthValue mirroring lag/lead", () => {
    expect(win.firstValue).toBe(firstValue)
    expect(win.lastValue).toBe(lastValue)
    expect(win.nthValue).toBe(nthValue)
  })

  it("win.firstValue inside over() compiles the same SQL as the flat export", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const a = db
      .selectFrom("ticks")
      .select({
        opening: over(firstValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    const b = db
      .selectFrom("ticks")
      .select({
        opening: over(win.firstValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .compile(db.printer())
    expect(a.sql).toBe(b.sql)
  })
})

// ─── PGlite roundtrip — firstValue / lastValue / nthValue ─────────────

describe("Window-value functions — PGlite roundtrip", () => {
  let pglite: PGlite

  beforeAll(async () => {
    pglite = new PGlite()
    await pglite.exec(`
      CREATE TABLE ticks (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        price REAL NOT NULL
      );

      INSERT INTO ticks (symbol, ts, price) VALUES
        ('AAPL', 1, 100.0),
        ('AAPL', 2, 110.0),
        ('AAPL', 3, 105.0),
        ('AAPL', 4, 115.0),
        ('AAPL', 5, 120.0);
    `)
  })

  afterAll(async () => {
    await pglite.close()
  })

  it("firstValue returns the opening price for the partition", async () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("ticks")
      .select("id", "price", "ts")
      .select({
        opening: over(firstValue(price), (w) => w.partitionBy("symbol").orderBy("ts")),
      })
      .orderBy("ts")
      .compile(db.printer())

    const result = await pglite.query<{ id: number; price: number; opening: number }>(
      q.sql,
      q.params as any[],
    )
    // The opening price (first row in the AAPL partition by ts) is 100.0
    // for every row.
    expect(result.rows.map((r) => Number(r.opening))).toEqual([100, 100, 100, 100, 100])
  })

  it("lastValue with unbounded frame returns the closing price", async () => {
    const db = sumak({ dialect: pgDialect(), tables })
    // Need explicit unbounded-both frame — default RANGE PRECEDING-CURRENT
    // would make LAST_VALUE return the current row's value.
    const q = db
      .selectFrom("ticks")
      .select("id", "price", "ts")
      .select({
        closing: over(lastValue(price), (w) =>
          w
            .partitionBy("symbol")
            .orderBy("ts")
            .rows({ type: "unbounded_preceding" }, { type: "unbounded_following" }),
        ),
      })
      .orderBy("ts")
      .compile(db.printer())

    const result = await pglite.query<{ id: number; price: number; closing: number }>(
      q.sql,
      q.params as any[],
    )
    // The closing price (last row in the AAPL partition by ts) is 120.0
    // for every row.
    expect(result.rows.map((r) => Number(r.closing))).toEqual([120, 120, 120, 120, 120])
  })

  it("nthValue picks the Nth value (3rd) from each partition", async () => {
    const db = sumak({ dialect: pgDialect(), tables })
    // Use an unbounded-both frame so NTH_VALUE sees the whole partition.
    const q = db
      .selectFrom("ticks")
      .select("id", "price", "ts")
      .select({
        third: over(nthValue(price, 3), (w) =>
          w
            .partitionBy("symbol")
            .orderBy("ts")
            .rows({ type: "unbounded_preceding" }, { type: "unbounded_following" }),
        ),
      })
      .orderBy("ts")
      .compile(db.printer())

    const result = await pglite.query<{ id: number; price: number; third: number | null }>(
      q.sql,
      q.params as any[],
    )
    // The 3rd row's price (ts=3) is 105.0 — same value for every row in
    // the partition because the frame is the whole partition.
    expect(result.rows.map((r) => (r.third == null ? null : Number(r.third)))).toEqual([
      105, 105, 105, 105, 105,
    ])
  })
})
