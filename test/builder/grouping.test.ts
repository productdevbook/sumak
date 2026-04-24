import { describe, expect, it } from "vitest"

import { col } from "../../src/ast/expression.ts"
import { cube, groupingSets, rollup } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { InvalidExpressionError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const schema = {
  sales: {
    id: serial().primaryKey(),
    region: text().notNull(),
    category: text().notNull(),
    amount: integer().notNull(),
  },
}

describe("groupingSets / cube / rollup — SQL emission", () => {
  it("PG: GROUPING SETS renders parenthesised sets", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    // Low-level approach: craft groupBy via groupingSets + col refs.
    const { sql } = db
      .selectFrom("sales")
      .select("region", "category")
      .groupBy(groupingSets([[col("region"), col("category")], [col("region")], []]))
      .toSQL()
    expect(sql).toMatch(/GROUP BY GROUPING SETS/)
    expect(sql).toMatch(/\(\s*"region"\s*,\s*"category"\s*\)/)
    expect(sql).toMatch(/\(\s*"region"\s*\)/)
    expect(sql).toMatch(/\(\s*\)/)
  })

  it("PG: CUBE(a, b) flattens to single list", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    const { sql } = db
      .selectFrom("sales")
      .select("region", "category")
      .groupBy(cube(col("region"), col("category")))
      .toSQL()
    expect(sql).toMatch(/GROUP BY CUBE\s*\(\s*"region"\s*,\s*"category"\s*\)/)
  })

  it("PG: ROLLUP(a, b) flattens to single list", () => {
    const db = sumak({ dialect: pgDialect(), tables: schema })
    const { sql } = db
      .selectFrom("sales")
      .select("region")
      .groupBy(rollup(col("region"), col("category")))
      .toSQL()
    expect(sql).toMatch(/GROUP BY ROLLUP\s*\(\s*"region"\s*,\s*"category"\s*\)/)
  })

  it("MySQL: GROUPING SETS is rejected at compile time", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: schema })
    expect(() =>
      db
        .selectFrom("sales")
        .select("region")
        .groupBy(groupingSets([[col("region")]]))
        .toSQL(),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("MySQL: ROLLUP is rejected at compile time (use WITH ROLLUP via raw SQL)", () => {
    const db = sumak({ dialect: mysqlDialect(), tables: schema })
    expect(() =>
      db
        .selectFrom("sales")
        .select("region")
        .groupBy(rollup(col("region")))
        .toSQL(),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("SQLite: GROUPING SETS rejected; ROLLUP accepted", () => {
    const db = sumak({ dialect: sqliteDialect(), tables: schema })
    expect(() =>
      db
        .selectFrom("sales")
        .select("region")
        .groupBy(groupingSets([[col("region")]]))
        .toSQL(),
    ).toThrow(UnsupportedDialectFeatureError)

    const { sql } = db
      .selectFrom("sales")
      .select("region")
      .groupBy(rollup(col("region")))
      .toSQL()
    expect(sql).toMatch(/GROUP BY ROLLUP/)
  })

  it("MSSQL: all three grouping kinds accepted", () => {
    const db = sumak({ dialect: mssqlDialect(), tables: schema })
    const { sql: s1 } = db
      .selectFrom("sales")
      .select("region")
      .groupBy(cube(col("region")))
      .toSQL()
    expect(s1).toMatch(/CUBE/)

    const { sql: s2 } = db
      .selectFrom("sales")
      .select("region")
      .groupBy(groupingSets([[col("region")]]))
      .toSQL()
    expect(s2).toMatch(/GROUPING SETS/)
  })
})

describe("grouping builder — input validation", () => {
  it("groupingSets([]) throws", () => {
    expect(() => groupingSets([])).toThrow(InvalidExpressionError)
  })

  it("cube() with no args throws", () => {
    expect(() => cube()).toThrow(/at least one grouping expression/)
  })

  it("rollup() with no args throws", () => {
    expect(() => rollup()).toThrow(/at least one grouping expression/)
  })
})
