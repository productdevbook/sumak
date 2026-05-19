import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { over, sum } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { InvalidExpressionError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  events: {
    id: serial().primaryKey(),
    user_id: integer().notNull(),
    bucket: text().notNull(),
    amount: integer().notNull(),
  },
}

const pg = sumak({ dialect: pgDialect(), tables })
const my = sumak({ dialect: mysqlDialect(), tables })
const sl = sumak({ dialect: sqliteDialect(), tables })
const ms = sumak({ dialect: mssqlDialect(), tables })

describe("Window frame EXCLUDE clause — SQL output", () => {
  describe("PostgreSQL emits each EXCLUDE option", () => {
    it("EXCLUDE CURRENT ROW", () => {
      const q = pg
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .partitionBy("user_id")
              .orderBy("id")
              .rows({ type: "unbounded_preceding" }, { type: "current_row" })
              .exclude("current_row"),
          ),
        })
        .compile(pg.printer())
      expect(q.sql).toContain(
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW",
      )
    })

    it("EXCLUDE GROUP", () => {
      const q = pg
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .orderBy("bucket")
              .rows({ type: "unbounded_preceding" }, { type: "unbounded_following" })
              .exclude("group"),
          ),
        })
        .compile(pg.printer())
      expect(q.sql).toContain(
        "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE GROUP",
      )
    })

    it("EXCLUDE TIES", () => {
      const q = pg
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .orderBy("bucket")
              .range({ type: "unbounded_preceding" }, { type: "unbounded_following" })
              .exclude("ties"),
          ),
        })
        .compile(pg.printer())
      expect(q.sql).toContain(
        "RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE TIES",
      )
    })

    it("EXCLUDE NO OTHERS (explicit form)", () => {
      const q = pg
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .orderBy("id")
              .rows({ type: "unbounded_preceding" }, { type: "current_row" })
              .exclude("no_others"),
          ),
        })
        .compile(pg.printer())
      expect(q.sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS")
    })

    it("composes with GROUPS frame kind", () => {
      const q = pg
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .orderBy("bucket")
              .groups({ type: "unbounded_preceding" }, { type: "current_row" })
              .exclude("current_row"),
          ),
        })
        .compile(pg.printer())
      expect(q.sql).toContain(
        "GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW",
      )
    })

    it("frame call after exclude preserves the modifier", () => {
      // .rows(...).exclude(...).rows(...) — the second `.rows()` should
      // keep the previously-set EXCLUDE, since the SQL grammar puts
      // EXCLUDE *after* the frame bounds and the builder API doesn't
      // mandate a specific call order.
      const q = pg
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .orderBy("id")
              .rows({ type: "preceding", value: 1 })
              .exclude("current_row")
              .rows({ type: "unbounded_preceding" }, { type: "current_row" }),
          ),
        })
        .compile(pg.printer())
      expect(q.sql).toContain(
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW",
      )
    })
  })

  describe("SQLite emits all four EXCLUDE options", () => {
    it("EXCLUDE CURRENT ROW", () => {
      const q = sl
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .orderBy("id")
              .rows({ type: "unbounded_preceding" }, { type: "current_row" })
              .exclude("current_row"),
          ),
        })
        .compile(sl.printer())
      expect(q.sql).toContain(
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW",
      )
    })

    it("EXCLUDE GROUP", () => {
      const q = sl
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .orderBy("bucket")
              .rows({ type: "unbounded_preceding" }, { type: "unbounded_following" })
              .exclude("group"),
          ),
        })
        .compile(sl.printer())
      expect(q.sql).toContain("EXCLUDE GROUP")
    })

    it("EXCLUDE TIES", () => {
      const q = sl
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w
              .orderBy("bucket")
              .range({ type: "unbounded_preceding" }, { type: "unbounded_following" })
              .exclude("ties"),
          ),
        })
        .compile(sl.printer())
      expect(q.sql).toContain("EXCLUDE TIES")
    })
  })

  describe("MySQL rejects EXCLUDE — UnsupportedDialectFeatureError", () => {
    it("EXCLUDE CURRENT ROW throws", () => {
      const q = my.selectFrom("events").select({
        running: over(sum(typedCol<number>("amount")), (w) =>
          w
            .orderBy("id")
            .rows({ type: "unbounded_preceding" }, { type: "current_row" })
            .exclude("current_row"),
        ),
      })
      expect(() => q.compile(my.printer())).toThrow(UnsupportedDialectFeatureError)
      expect(() => q.compile(my.printer())).toThrow(/EXCLUDE frame clause/)
    })

    it("plain frame without EXCLUDE still works", () => {
      const q = my
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w.orderBy("id").rows({ type: "unbounded_preceding" }, { type: "current_row" }),
          ),
        })
        .compile(my.printer())
      // Sanity check: MySQL accepts the same frame without the modifier.
      expect(q.sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW")
      expect(q.sql).not.toContain("EXCLUDE")
    })
  })

  describe("MSSQL rejects EXCLUDE — UnsupportedDialectFeatureError", () => {
    it("EXCLUDE GROUP throws", () => {
      const q = ms.selectFrom("events").select({
        running: over(sum(typedCol<number>("amount")), (w) =>
          w
            .orderBy("id")
            .rows({ type: "unbounded_preceding" }, { type: "current_row" })
            .exclude("group"),
        ),
      })
      expect(() => q.compile(ms.printer())).toThrow(UnsupportedDialectFeatureError)
      expect(() => q.compile(ms.printer())).toThrow(/EXCLUDE frame clause/)
    })

    it("plain ROWS frame without EXCLUDE still works", () => {
      const q = ms
        .selectFrom("events")
        .select({
          running: over(sum(typedCol<number>("amount")), (w) =>
            w.orderBy("id").rows({ type: "unbounded_preceding" }, { type: "current_row" }),
          ),
        })
        .compile(ms.printer())
      expect(q.sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW")
      expect(q.sql).not.toContain("EXCLUDE")
    })
  })

  describe("Builder error surface", () => {
    it("throws InvalidExpressionError when .exclude() is called before a frame", () => {
      expect(() =>
        pg
          .selectFrom("events")
          .select({
            running: over(sum(typedCol<number>("amount")), (w) =>
              w.orderBy("id").exclude("current_row"),
            ),
          })
          .compile(pg.printer()),
      ).toThrow(InvalidExpressionError)
    })
  })
})

describe("Window frame EXCLUDE — PGlite roundtrip", () => {
  let pglite: PGlite

  beforeAll(async () => {
    pglite = new PGlite()
    await pglite.exec(`
      CREATE TABLE events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        amount INTEGER NOT NULL
      );

      INSERT INTO events (user_id, bucket, amount) VALUES
        (1, 'a',  10),
        (1, 'a',  20),
        (1, 'b',  30),
        (1, 'b',  40),
        (1, 'c',  50);
    `)
  })

  afterAll(async () => {
    await pglite.close()
  })

  it("EXCLUDE CURRENT ROW removes the current row from the cumulative sum", async () => {
    // Without EXCLUDE: cumulative sums are 10, 30, 60, 100, 150.
    // With EXCLUDE CURRENT ROW: 0 (or NULL), 10, 30, 60, 100.
    const baseline = pg
      .selectFrom("events")
      .select("id", "amount")
      .select({
        running: over(sum(typedCol<number>("amount")), (w) =>
          w.orderBy("id").rows({ type: "unbounded_preceding" }, { type: "current_row" }),
        ),
      })
      .orderBy("id")
      .compile(pg.printer())

    const excluded = pg
      .selectFrom("events")
      .select("id", "amount")
      .select({
        running: over(sum(typedCol<number>("amount")), (w) =>
          w
            .orderBy("id")
            .rows({ type: "unbounded_preceding" }, { type: "current_row" })
            .exclude("current_row"),
        ),
      })
      .orderBy("id")
      .compile(pg.printer())

    const baseRows = await pglite.query<{ id: number; amount: number; running: number | null }>(
      baseline.sql,
      baseline.params as any[],
    )
    const exRows = await pglite.query<{ id: number; amount: number; running: number | null }>(
      excluded.sql,
      excluded.params as any[],
    )

    expect(baseRows.rows.map((r) => Number(r.running))).toEqual([10, 30, 60, 100, 150])
    // First excluded row has no other rows in its frame, so SUM is NULL.
    expect(exRows.rows[0]!.running).toBeNull()
    // Subsequent rows match the previous baseline value (current row drops out).
    expect(exRows.rows.slice(1).map((r) => Number(r.running))).toEqual([10, 30, 60, 100])
  })

  it("EXCLUDE GROUP drops peers (rows with equal ORDER BY keys)", async () => {
    // Ordering by `bucket` makes rows 1/2 peers (bucket='a'), rows 3/4
    // peers (bucket='b'), row 5 alone (bucket='c').
    // RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING covers
    // every row (= 150). EXCLUDE GROUP drops the row's own peer group:
    //   bucket='a' peers (10+20=30) -> excluded -> 150 - 30 = 120
    //   bucket='b' peers (30+40=70) -> excluded -> 150 - 70 = 80
    //   bucket='c' (50)             -> excluded -> 150 - 50 = 100
    const q = pg
      .selectFrom("events")
      .select("id", "bucket", "amount")
      .select({
        running: over(sum(typedCol<number>("amount")), (w) =>
          w
            .orderBy("bucket")
            .range({ type: "unbounded_preceding" }, { type: "unbounded_following" })
            .exclude("group"),
        ),
      })
      .orderBy("id")
      .compile(pg.printer())

    const result = await pglite.query<{
      id: number
      bucket: string
      amount: number
      running: number
    }>(q.sql, q.params as any[])
    const byId = Object.fromEntries(result.rows.map((r) => [r.id, Number(r.running)]))
    expect(byId).toEqual({ 1: 120, 2: 120, 3: 80, 4: 80, 5: 100 })
  })

  it("EXCLUDE TIES keeps the current row, drops only peers", async () => {
    // Same setup as EXCLUDE GROUP, but the current row stays. So row 1
    // (bucket='a', amount=10) keeps its 10 + everything outside its
    // peer group (30+40+50 = 120) = 130. Row 2 keeps its 20 + 120 = 140.
    const q = pg
      .selectFrom("events")
      .select("id", "bucket", "amount")
      .select({
        running: over(sum(typedCol<number>("amount")), (w) =>
          w
            .orderBy("bucket")
            .range({ type: "unbounded_preceding" }, { type: "unbounded_following" })
            .exclude("ties"),
        ),
      })
      .orderBy("id")
      .compile(pg.printer())

    const result = await pglite.query<{
      id: number
      bucket: string
      amount: number
      running: number
    }>(q.sql, q.params as any[])
    const byId = Object.fromEntries(result.rows.map((r) => [r.id, Number(r.running)]))
    expect(byId).toEqual({ 1: 130, 2: 140, 3: 110, 4: 120, 5: 150 })
  })
})
