import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG proof that column-level CHECK constraints make it through the
// migration pipeline: the DDL compiles, the CHECK is enforced by the
// engine (INSERT of a bad row fails), and a valid row still goes in.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

describe("column CHECK constraint — pglite roundtrip", () => {
  it("rejects rows that violate the check, accepts valid rows", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      ck_products: {
        id: serial().primaryKey(),
        name: text().notNull(),
        price: integer().notNull().check("price >= 0", { name: "ck_price_non_negative" }),
      },
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })

    await applyMigration(db, {}, schema)

    const good = await db
      .insertInto("ck_products")
      .values({ name: "shirt", price: 100 })
      .returningAll()
      .one()
    expect(good.price).toBe(100)

    await expect(
      db.insertInto("ck_products").values({ name: "broken", price: -1 }).exec(),
    ).rejects.toThrow(/ck_price_non_negative|check/i)
  })
})
