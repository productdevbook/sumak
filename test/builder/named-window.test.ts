import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { over, rank, rowNumber, sum } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  sales: {
    id: serial().primaryKey(),
    region: text().notNull(),
    sale_date: text().notNull(),
    amount: integer().notNull(),
  },
}

const pg = sumak({ dialect: pgDialect(), tables })
const my = sumak({ dialect: mysqlDialect(), tables })
const sl = sumak({ dialect: sqliteDialect(), tables })
const ms = sumak({ dialect: mssqlDialect(), tables })

describe("Named WINDOW clause — SQL output", () => {
  it("single named window referenced once (PG)", () => {
    const q = pg
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region").orderBy("sale_date"))
      .select({ rn: over(rowNumber(), "w") })
      .compile(pg.printer())
    expect(q.sql).toContain('ROW_NUMBER() OVER "w"')
    expect(q.sql).toContain('WINDOW "w" AS (PARTITION BY "region" ORDER BY "sale_date" ASC)')
  })

  it("two functions share one named window (the main use case) — PG", () => {
    const q = pg
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region").orderBy("sale_date"))
      .select({
        rn: over(rowNumber(), "w"),
        running: over(sum(typedCol<number>("amount")), "w"),
      })
      .compile(pg.printer())
    expect(q.sql).toContain('ROW_NUMBER() OVER "w"')
    expect(q.sql).toContain('SUM("amount") OVER "w"')
    // The WINDOW clause must appear exactly once even though two
    // OVERs reference it — that's the whole point of the feature.
    const matches = q.sql.match(/WINDOW "w" AS \(/g) ?? []
    expect(matches.length).toBe(1)
  })

  it("window inheritance — w2 AS (w ORDER BY y)", () => {
    const q = pg
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region"))
      .window("w2", (b) => b.orderBy("sale_date"), { from: "w" })
      .select({
        r: over(rank(), "w2"),
      })
      .compile(pg.printer())
    expect(q.sql).toContain('WINDOW "w" AS (PARTITION BY "region")')
    // `w2 AS (w ORDER BY ...)` — base name first, then the added layer
    expect(q.sql).toContain('"w2" AS ("w" ORDER BY "sale_date" ASC)')
    expect(q.sql).toContain('RANK() OVER "w2"')
  })

  it("named window with frame", () => {
    const q = pg
      .selectFrom("sales")
      .window("w", (b) =>
        b
          .partitionBy("region")
          .orderBy("sale_date")
          .rows({ type: "unbounded_preceding" }, { type: "current_row" }),
      )
      .select({ run: over(sum(typedCol<number>("amount")), "w") })
      .compile(pg.printer())
    expect(q.sql).toContain(
      'WINDOW "w" AS (PARTITION BY "region" ORDER BY "sale_date" ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)',
    )
  })

  it("MySQL emits the same WINDOW clause shape", () => {
    const q = my
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region").orderBy("sale_date"))
      .select({
        rn: over(rowNumber(), "w"),
        running: over(sum(typedCol<number>("amount")), "w"),
      })
      .compile(my.printer())
    // MySQL uses backticks for identifiers.
    expect(q.sql).toContain("ROW_NUMBER() OVER `w`")
    expect(q.sql).toContain("SUM(`amount`) OVER `w`")
    expect(q.sql).toContain("WINDOW `w` AS (PARTITION BY `region` ORDER BY `sale_date` ASC)")
  })

  it("SQLite emits WINDOW clause", () => {
    const q = sl
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region").orderBy("sale_date"))
      .select({ rn: over(rowNumber(), "w") })
      .compile(sl.printer())
    expect(q.sql).toContain('ROW_NUMBER() OVER "w"')
    expect(q.sql).toContain('WINDOW "w" AS (PARTITION BY "region" ORDER BY "sale_date" ASC)')
  })

  it("MSSQL rejects WINDOW clause with UnsupportedDialectFeatureError", () => {
    const q = ms
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region").orderBy("sale_date"))
      .select({ rn: over(rowNumber(), "w") })
    expect(() => q.compile(ms.printer())).toThrow(/named WINDOW clause/)
  })

  it("MSSQL rejects bare `OVER name` even when no WINDOW clause is present", () => {
    // Reach through the builder by hand: simulate a stray windowName reference
    // (e.g. via raw AST construction or after a buggy plugin transform).
    const q = ms.selectFrom("sales").select({ rn: over(rowNumber(), "w") })
    expect(() => q.compile(ms.printer())).toThrow(/named WINDOW reference/)
  })

  it("placed after HAVING and before ORDER BY in the canonical grammar", () => {
    const q = pg
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region").orderBy("sale_date"))
      .select({ rn: over(rowNumber(), "w") })
      .orderBy("id")
      .limit(10)
      .compile(pg.printer())
    const windowAt = q.sql.indexOf("WINDOW ")
    const orderAt = q.sql.indexOf("ORDER BY")
    const limitAt = q.sql.indexOf("LIMIT")
    expect(windowAt).toBeGreaterThan(0)
    expect(orderAt).toBeGreaterThan(windowAt)
    expect(limitAt).toBeGreaterThan(orderAt)
  })

  it("no WINDOW clause when never registered (regression: empty list is skipped)", () => {
    const q = pg
      .selectFrom("sales")
      .select({ rn: over(rowNumber(), (w) => w.orderBy("id")) })
      .compile(pg.printer())
    expect(q.sql).not.toContain("WINDOW")
  })
})

describe("Named WINDOW clause — PGlite roundtrip", () => {
  let pglite: PGlite

  beforeAll(async () => {
    pglite = new PGlite()
    await pglite.exec(`
      CREATE TABLE sales (
        id SERIAL PRIMARY KEY,
        region TEXT NOT NULL,
        sale_date TEXT NOT NULL,
        amount INTEGER NOT NULL
      );

      INSERT INTO sales (region, sale_date, amount) VALUES
        ('North', '2025-01-01', 100),
        ('North', '2025-01-02', 150),
        ('North', '2025-01-03', 200),
        ('South', '2025-01-01',  50),
        ('South', '2025-01-02', 120),
        ('South', '2025-01-03',  80);
    `)
  })

  afterAll(async () => {
    await pglite.close()
  })

  it("two OVERs sharing a named window produce correct results", async () => {
    const q = pg
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region").orderBy("sale_date"))
      .select("region", "sale_date", "amount")
      .select({
        rn: over(rowNumber(), "w"),
        running: over(sum(typedCol<number>("amount")), "w"),
      })
      .orderBy("region")
      .orderBy("sale_date")
      .compile(pg.printer())

    const result = await pglite.query<{
      region: string
      sale_date: string
      amount: number
      rn: number
      running: number
    }>(q.sql, q.params as any[])

    // Each region partition restarts the row number and running sum.
    expect(result.rows.length).toBe(6)

    const north = result.rows.filter((r) => r.region === "North")
    const south = result.rows.filter((r) => r.region === "South")

    // North: 100, 250, 450 cumulative
    expect(north.map((r) => Number(r.rn))).toEqual([1, 2, 3])
    expect(north.map((r) => Number(r.running))).toEqual([100, 250, 450])
    // South: 50, 170, 250
    expect(south.map((r) => Number(r.rn))).toEqual([1, 2, 3])
    expect(south.map((r) => Number(r.running))).toEqual([50, 170, 250])
  })

  it("window inheritance roundtrips against PGlite", async () => {
    const q = pg
      .selectFrom("sales")
      .window("w", (b) => b.partitionBy("region"))
      .window("w2", (b) => b.orderBy("sale_date"), { from: "w" })
      .select("region", "sale_date")
      .select({ r: over(rank(), "w2") })
      .orderBy("region")
      .orderBy("sale_date")
      .compile(pg.printer())

    const result = await pglite.query<{ region: string; sale_date: string; r: number }>(
      q.sql,
      q.params as any[],
    )
    expect(result.rows.length).toBe(6)
    // Both partitions of three rows produce rank 1, 2, 3 in date order.
    const north = result.rows.filter((r) => r.region === "North").map((r) => Number(r.r))
    const south = result.rows.filter((r) => r.region === "South").map((r) => Number(r.r))
    expect(north).toEqual([1, 2, 3])
    expect(south).toEqual([1, 2, 3])
  })
})
