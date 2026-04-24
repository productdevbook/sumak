import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { audit } from "../../src/plugin/factories.ts"
import { integer, serial, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG roundtrip: the audit plugin writes the resolved user id into
// created_by / updated_by on INSERT, and into updated_by on UPDATE.
// Proves the columns and params make it through to the wire.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS au_posts CASCADE;
    CREATE TABLE au_posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      created_by INT,
      updated_by INT
    );
  `)
})

afterAll(async () => {
  await pg?.close()
})

describe("audit plugin — userId injection against pglite", () => {
  it("INSERT stamps created_by + updated_by with the current user id", async () => {
    const driver = pgliteDriver(pg)
    let currentUser: number | undefined = 42
    const db = sumak({
      dialect: pgDialect(),
      driver,
      plugins: [audit({ tables: ["au_posts"], userId: () => currentUser })],
      tables: {
        au_posts: {
          id: serial().primaryKey(),
          title: text().notNull(),
          created_at: timestamp().nullable(),
          updated_at: timestamp().nullable(),
          created_by: integer().nullable(),
          updated_by: integer().nullable(),
        },
      },
    })
    const row = await db.insertInto("au_posts").values({ title: "hi" }).returningAll().one()
    expect(row.created_by).toBe(42)
    expect(row.updated_by).toBe(42)
    expect(row.created_at).toBeTruthy()

    currentUser = 7
    const updated = await db
      .update("au_posts")
      .set({ title: "re-hi" })
      .where(({ id }) => id.eq(row.id as number))
      .returningAll()
      .one()
    // created_by unchanged; updated_by follows the current user.
    expect(updated.created_by).toBe(42)
    expect(updated.updated_by).toBe(7)
  })
})
