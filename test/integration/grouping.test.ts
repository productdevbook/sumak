import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { col } from "../../src/ast/expression.ts"
import { typedCol } from "../../src/ast/typed-expression.ts"
import { cube, groupingSets, rollup, sum } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS gr_sales CASCADE;
    CREATE TABLE gr_sales (id SERIAL PRIMARY KEY, region TEXT NOT NULL, category TEXT NOT NULL, amount INT NOT NULL);
    INSERT INTO gr_sales (region, category, amount) VALUES
      ('east', 'a', 10), ('east', 'b', 20),
      ('west', 'a', 30), ('west', 'b', 40);
  `)
})

afterAll(async () => {
  await pg?.close()
})

describe("GROUPING SETS / CUBE / ROLLUP — pglite roundtrip", () => {
  const schema = {
    gr_sales: {
      id: serial().primaryKey(),
      region: text().notNull(),
      category: text().notNull(),
      amount: integer().notNull(),
    },
  }

  it("ROLLUP(region, category) returns subtotals + grand total", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("gr_sales")
      .select("region", "category")
      .select({ total: sum(typedCol<number>("amount")) })
      .groupBy(rollup(col("region"), col("category")))
      .many()
    // 4 leaf rows + 2 region subtotals + 1 grand total = 7.
    expect(rows.length).toBe(7)
    const grandTotal = rows.find((r) => r.region === null && r.category === null)
    expect(grandTotal).toBeDefined()
    expect(Number(grandTotal!.total)).toBe(100)
  })

  it("CUBE(region, category) covers all 2^2 combinations", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("gr_sales")
      .select("region", "category")
      .select({ total: sum(typedCol<number>("amount")) })
      .groupBy(cube(col("region"), col("category")))
      .many()
    // 4 (region, category) + 2 region + 2 category + 1 grand = 9.
    expect(rows.length).toBe(9)
  })

  it("GROUPING SETS ((region), (category)) emits union of the two groupings", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("gr_sales")
      .select("region", "category")
      .select({ total: sum(typedCol<number>("amount")) })
      .groupBy(groupingSets([[col("region")], [col("category")]]))
      .many()
    // 2 regions + 2 categories = 4.
    expect(rows.length).toBe(4)
  })
})
