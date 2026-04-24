import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { val, valuesClause } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS vc_scores CASCADE;
    CREATE TABLE vc_scores (id SERIAL PRIMARY KEY, name TEXT NOT NULL, points INT NOT NULL);
    INSERT INTO vc_scores (name, points) VALUES ('A', 50), ('B', 150), ('C', 1200);
  `)
})

afterAll(async () => {
  await pg?.close()
})

describe("VALUES derived table against pglite", () => {
  it("SELECT ... FROM (VALUES ...) returns each row", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: pgliteDriver(pg),
      tables: {
        vc_scores: {
          id: serial().primaryKey(),
          name: text().notNull(),
          points: integer().notNull(),
        },
      },
    })
    const seed = valuesClause({
      alias: "seed",
      columns: ["id", "label"],
      rows: [
        [val(1), val("one")],
        [val(2), val("two")],
        [val(3), val("three")],
      ],
    })
    const rows = await db.selectFromValues(seed).selectAll().many()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.label).sort()).toEqual(["one", "three", "two"])
  })
})
