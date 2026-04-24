import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Builder-level `.stream()` against the pglite test driver. pglite
// doesn't run a real server, so there's no wire-level cursor — the
// adapter yields from a buffered query(). Still covers the contract:
// `for await` yields rows, `break` stops the iterator cleanly, plugin
// `transformResult` runs per row.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS st_events;
    CREATE TABLE st_events (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, tally INT NOT NULL);
    INSERT INTO st_events (kind, tally) VALUES
      ('a', 1), ('b', 2), ('c', 3), ('d', 4), ('e', 5);
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  st_events: {
    id: serial().primaryKey(),
    kind: text().notNull(),
    tally: integer().notNull(),
  },
}

describe("TypedSelectBuilder.stream() — pglite", () => {
  it("yields every row in insertion order", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const seen: string[] = []
    for await (const row of db.selectFrom("st_events").selectAll().stream()) {
      seen.push(row.kind as string)
    }
    expect(seen).toEqual(["a", "b", "c", "d", "e"])
  })

  it("break stops the iterator — fewer rows observed than total", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    let seen = 0
    for await (const _row of db.selectFrom("st_events").selectAll().stream()) {
      seen++
      if (seen === 2) break
      void _row
    }
    expect(seen).toBe(2)
  })

  it("aborted signal — stream throws AbortError", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(async () => {
      for await (const _row of db
        .selectFrom("st_events")
        .selectAll()
        .stream({ signal: ctrl.signal })) {
        void _row
      }
    }).rejects.toMatchObject({ name: "AbortError" })
  })
})
