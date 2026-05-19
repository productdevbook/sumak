import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedEq, typedLit } from "../../src/ast/typed-expression.ts"
import { Col, jsonValue } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { jsonb, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that JSON_VALUE — both the bare form and the
// `RETURNING <type>` casting variant — compile through the sumak
// printer and return correctly typed values from PG 17 (the version
// shipped with PGlite 0.4.x). MySQL 8 / MSSQL printers emit the same
// shape but live behind env-gated suites (mysql/, mssql/); the unit
// tests in test/builder/json-value.test.ts cover their SQL output.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS jv_events CASCADE;
    CREATE TABLE jv_events (
      id SERIAL PRIMARY KEY,
      body JSONB NOT NULL,
      raw TEXT
    );
    INSERT INTO jv_events (body, raw) VALUES
      ('{"name": "alice", "age": 30, "tags": ["a","b"]}', '{"x":1}'),
      ('{"name": "bob",   "age": 25, "tags": ["c"]}',     '{"x":2}'),
      ('{"name": "carol", "age": 99}',                    NULL);
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  jv_events: {
    id: serial().primaryKey(),
    body: jsonb().notNull(),
    raw: text(),
  },
}

const bodyCol = new Col("body")

describe("JSON_VALUE roundtrip via PGlite (PG 17)", () => {
  it("bare JSON_VALUE returns the scalar as text", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jv_events")
      .select({ name: jsonValue<string>(bodyCol, "$.name") as any })
      .orderBy("id")
      .many()
    expect(rows.map((r) => r.name)).toEqual(["alice", "bob", "carol"])
    // Default return type is text — values are strings, not JSON
    // strings (no surrounding quotes).
    expect(typeof rows[0].name).toBe("string")
    expect(rows[0].name).toBe("alice")
  })

  it("RETURNING int casts the extracted value to integer", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jv_events")
      .select({
        age: jsonValue<number>(bodyCol, "$.age", { returning: "int" }) as any,
      })
      .orderBy("id")
      .many()
    expect(rows.map((r) => r.age)).toEqual([30, 25, 99])
    expect(typeof rows[0].age).toBe("number")
  })

  it("missing key returns NULL (default ON EMPTY behavior)", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jv_events")
      .select({ missing: jsonValue<string>(bodyCol, "$.nope") as any })
      .orderBy("id")
      .many()
    // SQL:2016 default for a missing path is `NULL ON EMPTY` →
    // the cell is null on every row.
    expect(rows.map((r) => r.missing)).toEqual([null, null, null])
  })

  it("RETURNING numeric(10, 2) preserves precision", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jv_events")
      .select({
        age: jsonValue(bodyCol, "$.age", { returning: "numeric(10, 2)" }) as any,
      })
      .orderBy("id")
      .many()
    // PG returns NUMERIC as a string (drivers keep arbitrary-precision
    // values intact); compare on stringified form.
    expect(rows.map((r) => String(r.age))).toEqual(["30.00", "25.00", "99.00"])
  })

  it("works in WHERE — JSON_VALUE = literal narrows rows", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("jv_events")
      .select("id")
      .where(typedEq(jsonValue<string>(bodyCol, "$.name"), typedLit("alice")))
      .many()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
  })
})
