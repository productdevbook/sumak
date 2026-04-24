import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { sql } from "../../src/builder/sql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { boolean, integer, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG roundtrip for the three default / generated paths:
//   - literal default:     `.defaultTo(true)`.
//   - expression default:  `.defaultTo(sql`CURRENT_TIMESTAMP`)`.
//   - generated column:    `.generatedAlwaysAs(sql`a * b`, { stored })`.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

describe("column defaults + generated — pglite roundtrip", () => {
  it("literal default fires on INSERT when the column is omitted", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      cd_users: {
        id: integer().primaryKey(),
        name: text().notNull(),
        active: boolean().defaultTo(true),
      },
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)
    const row = await db
      .insertInto("cd_users")
      .values({ id: 1, name: "Alice" })
      .returningAll()
      .one()
    expect(row.active).toBe(true)
  })

  it("CURRENT_TIMESTAMP expression default populates created_at at INSERT time", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      cd_events: {
        id: integer().primaryKey(),
        kind: text().notNull(),
        created_at: timestamp().defaultTo(sql`CURRENT_TIMESTAMP`),
      },
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)
    const row = await db
      .insertInto("cd_events")
      .values({ id: 1, kind: "login" })
      .returningAll()
      .one()
    // PG returns a Date object for a timestamp column; the exact
    // value is "close to now" and we don't pin it down — just that
    // it was set server-side.
    expect(row.created_at).toBeTruthy()
  })

  it("GENERATED STORED column computes from other columns on INSERT", async () => {
    const driver = pgliteDriver(pg)
    const schema = {
      cd_boxes: {
        id: integer().primaryKey(),
        width: integer().notNull(),
        height: integer().notNull(),
        area: integer().generatedAlwaysAs(sql`width * height`, { stored: true }),
      },
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: schema })
    await applyMigration(db, {}, schema)
    const row = await db
      .insertInto("cd_boxes")
      .values({ id: 1, width: 4, height: 5 })
      .returningAll()
      .one()
    expect(row.area).toBe(20)
  })
})
