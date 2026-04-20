import { describe, expect, it } from "vitest"

import {
  count,
  countDistinct,
  denseRank,
  lag,
  lead,
  ntile,
  over,
  rank,
  rowNumber,
  sum,
  val,
} from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { boolean, integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    employees: {
      id: serial().primaryKey(),
      name: text().notNull(),
      dept: text().notNull(),
      salary: integer().notNull(),
      active: boolean().defaultTo(true),
    },
  },
})

const p = db.printer()

describe("Window Functions", () => {
  it("ROW_NUMBER() OVER (ORDER BY id)", () => {
    const q = db
      .selectFrom("employees")
      .select("name")
      .select({
        rn: over(rowNumber(), (w) => w.orderBy("id")),
      })
      .compile(p)
    expect(q.sql).toContain("ROW_NUMBER() OVER (ORDER BY")
    expect(q.sql).toContain('"rn"')
  })

  it("ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC)", () => {
    const q = db
      .selectFrom("employees")
      .select({
        rn: over(rowNumber(), (w) => w.partitionBy("dept").orderBy("salary", "DESC")),
      })
      .compile(p)
    expect(q.sql).toContain("ROW_NUMBER() OVER (PARTITION BY")
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("DESC")
  })

  it("RANK()", () => {
    const q = db
      .selectFrom("employees")
      .select({
        rnk: over(rank(), (w) => w.orderBy("salary", "DESC")),
      })
      .compile(p)
    expect(q.sql).toContain("RANK() OVER")
  })

  it("DENSE_RANK()", () => {
    const q = db
      .selectFrom("employees")
      .select({
        drnk: over(denseRank(), (w) => w.orderBy("salary", "DESC")),
      })
      .compile(p)
    expect(q.sql).toContain("DENSE_RANK() OVER")
  })

  it("SUM() OVER with frame", () => {
    const q = db
      .selectFrom("employees")
      .select({
        running_total: over(sum(val(1) as any), (w) =>
          w
            .partitionBy("dept")
            .orderBy("salary")
            .rows({ type: "unbounded_preceding" }, { type: "current_row" }),
        ),
      })
      .compile(p)
    expect(q.sql).toContain("SUM(")
    expect(q.sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW")
  })

  it("COUNT() OVER with range frame", () => {
    const q = db
      .selectFrom("employees")
      .select({
        cnt: over(count(), (w) =>
          w
            .orderBy("salary")
            .range({ type: "preceding", value: 100 }, { type: "following", value: 100 }),
        ),
      })
      .compile(p)
    expect(q.sql).toContain("RANGE BETWEEN 100 PRECEDING AND 100 FOLLOWING")
  })

  it("NTILE(4)", () => {
    const q = db
      .selectFrom("employees")
      .select({
        quartile: over(ntile(4), (w) => w.orderBy("salary", "DESC")),
      })
      .compile(p)
    expect(q.sql).toContain("NTILE(4)")
    expect(q.sql).toContain("OVER")
  })

  it("LAG()", () => {
    const q = db
      .selectFrom("employees")
      .select({
        prev_salary: over(lag(val(0) as any, 1), (w) => w.orderBy("salary")),
      })
      .compile(p)
    expect(q.sql).toContain("LAG(")
    expect(q.sql).toContain("OVER")
  })

  it("LEAD()", () => {
    const q = db
      .selectFrom("employees")
      .select({
        next_salary: over(lead(val(0) as any, 1), (w) => w.orderBy("salary")),
      })
      .compile(p)
    expect(q.sql).toContain("LEAD(")
    expect(q.sql).toContain("OVER")
  })

  it("empty OVER ()", () => {
    const q = db
      .selectFrom("employees")
      .select({
        total: over(count(), (w) => w),
      })
      .compile(p)
    expect(q.sql).toContain("COUNT(*) OVER ()")
  })
})

describe("COUNT(DISTINCT)", () => {
  it("COUNT(DISTINCT col) in PG", () => {
    const q = db
      .selectFrom("employees")
      .select({ unique_count: countDistinct(val("test") as any) })
      .compile(p)
    expect(q.sql).toContain("COUNT(DISTINCT")
  })

  it("COUNT(DISTINCT col) in MySQL", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: {
        employees: {
          id: serial().primaryKey(),
          dept: text().notNull(),
        },
      },
    })
    const q = mydb
      .selectFrom("employees")
      .select({ unique_count: countDistinct(val("test") as any) })
      .compile(mydb.printer())
    expect(q.sql).toContain("COUNT(DISTINCT")
  })

  it("COUNT(DISTINCT col) in MSSQL", () => {
    const msdb = sumak({
      dialect: mssqlDialect(),
      tables: {
        employees: {
          id: serial().primaryKey(),
          dept: text().notNull(),
        },
      },
    })
    const q = msdb
      .selectFrom("employees")
      .select({ unique_count: countDistinct(val("test") as any) })
      .compile(msdb.printer())
    expect(q.sql).toContain("COUNT(DISTINCT")
  })

  it("COUNT(DISTINCT col) in SQLite", () => {
    const sldb = sumak({
      dialect: sqliteDialect(),
      tables: {
        employees: {
          id: serial().primaryKey(),
          dept: text().notNull(),
        },
      },
    })
    const q = sldb
      .selectFrom("employees")
      .select({ unique_count: countDistinct(val("test") as any) })
      .compile(sldb.printer())
    expect(q.sql).toContain("COUNT(DISTINCT")
  })
})
