import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Col, jsonExists, jsonQuery } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { jsonb, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that JSON_QUERY and JSON_EXISTS compile through the
// sumak printer and return values from PG 17 (the version shipped with
// PGlite 0.4.x). MSSQL also accepts the standard syntax but lives
// behind an env-gated suite; MySQL / SQLite refuse at print time.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS jq_events CASCADE;
    CREATE TABLE jq_events (
      id SERIAL PRIMARY KEY,
      body JSONB NOT NULL,
      raw TEXT
    );
    INSERT INTO jq_events (body, raw) VALUES
      ('{"name": "alice", "address": {"city": "NYC", "zip": "10001"}, "tags": ["a","b"]}', '{"x":1}'),
      ('{"name": "bob",   "address": {"city": "SF",  "zip": "94101"}, "tags": ["c"]}',     '{"x":2}'),
      ('{"name": "carol"}',                                                                NULL);
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  jq_events: {
    id: serial().primaryKey(),
    body: jsonb().notNull(),
    raw: text(),
  },
}

const bodyCol = new Col("body")

describe("JSON_QUERY roundtrip via PGlite (PG 17)", () => {
  it("bare JSON_QUERY returns the sub-document as JSON", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jq_events")
      .select({ addr: jsonQuery<{ city: string; zip: string }>(bodyCol, "$.address") as any })
      .orderBy("id")
      .many()
    // PG 17's JSON_QUERY default returns jsonb; pglite decodes to JS
    // object. Rows 1 and 2 have addresses, row 3 doesn't (NULL).
    expect((rows[0] as any).addr).toMatchObject({ city: "NYC", zip: "10001" })
    expect((rows[1] as any).addr).toMatchObject({ city: "SF", zip: "94101" })
    expect((rows[2] as any).addr).toBeNull()
  })

  it("RETURNING jsonb is explicit and round-trips identically", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jq_events")
      .select({
        addr: jsonQuery<{ city: string }>(bodyCol, "$.address", { returning: "jsonb" }) as any,
      })
      .orderBy("id")
      .many()
    expect((rows[0] as any).addr).toMatchObject({ city: "NYC" })
    expect((rows[1] as any).addr).toMatchObject({ city: "SF" })
  })

  it("array path extraction", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jq_events")
      .select({ tags: jsonQuery<unknown[]>(bodyCol, "$.tags") as any })
      .orderBy("id")
      .many()
    // The full tags array is returned (not coerced to text).
    expect((rows[0] as any).tags).toEqual(["a", "b"])
    expect((rows[1] as any).tags).toEqual(["c"])
    // No tags on row 3 → NULL.
    expect((rows[2] as any).tags).toBeNull()
  })
})

describe("JSON_EXISTS roundtrip via PGlite (PG 17)", () => {
  it("returns boolean — true when path resolves, false otherwise", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jq_events")
      .select({
        hasAddr: jsonExists(bodyCol, "$.address") as any,
      })
      .orderBy("id")
      .many()
    expect((rows[0] as any).hasAddr).toBe(true)
    expect((rows[1] as any).hasAddr).toBe(true)
    expect((rows[2] as any).hasAddr).toBe(false)
  })

  it("works in WHERE — JSON_EXISTS narrows rows", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jq_events")
      .select("id")
      .where(() => jsonExists(bodyCol, "$.address"))
      .orderBy("id")
      .many()
    // Rows 1 and 2 have an address; row 3 doesn't.
    expect(rows.map((r: any) => r.id)).toEqual([1, 2])
  })

  it("missing path returns false", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jq_events")
      .select({ has: jsonExists(bodyCol, "$.nope") as any })
      .orderBy("id")
      .many()
    expect(rows.map((r: any) => r.has)).toEqual([false, false, false])
  })
})
