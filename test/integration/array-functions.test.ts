import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import {
  arrayAppend,
  arrayCat,
  arrayLength,
  arrayLiteral,
  arrayPosition,
  arrayPositions,
  arrayPrepend,
  arrayRemove,
  arrayReplace,
  arrayToString,
  unnest,
  val,
} from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that the PG array function builders compile through
// the sumak printer and that PG evaluates them with the documented
// semantics. The sumak schema-side has only scalar column factories
// today, so the array columns are created with raw `CREATE TABLE` DDL
// and reached via `typedCol<T[]>(...)`. The select shape returns rows
// keyed by the alias the builder emits.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS af_posts CASCADE;
    CREATE TABLE af_posts (
      id SERIAL PRIMARY KEY,
      tags TEXT[] NOT NULL,
      nums INT[] NOT NULL
    );
    INSERT INTO af_posts (tags, nums) VALUES
      (ARRAY['sql','pg'],            ARRAY[1, 2, 3]),
      (ARRAY['ts','sql','sql'],      ARRAY[5, 5, 6]),
      (ARRAY[]::TEXT[],              ARRAY[]::INT[]);
  `)
})

afterAll(async () => {
  await pg?.close()
})

// The sumak schema is scalar-only — we declare the columns as TEXT/INT
// here just to satisfy the schema-side typing. The actual SELECT shape
// is driven by the alias keys we pass to `.select({...})`, not the
// schema row type.
const schema = {
  af_posts: {
    id: serial().primaryKey(),
    tags: text().notNull(),
    nums: integer().notNull(),
  },
}

const tags = typedCol<string[]>("tags")
const nums = typedCol<number[]>("nums")

describe("arrayAppend roundtrip via PGlite", () => {
  it("ARRAY_APPEND appends an element to the tail", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ updated: arrayAppend(tags, val("new")) as never })
      .orderBy("id")
      .many()
    // Row 1: ['sql','pg'] → ['sql','pg','new']
    // Row 2: ['ts','sql','sql'] → ['ts','sql','sql','new']
    // Row 3: [] → ['new']
    expect(rows).toHaveLength(3)
    expect(rows[0].updated).toEqual(["sql", "pg", "new"])
    expect(rows[1].updated).toEqual(["ts", "sql", "sql", "new"])
    expect(rows[2].updated).toEqual(["new"])
  })
})

describe("arrayPrepend roundtrip via PGlite", () => {
  it("ARRAY_PREPEND inserts an element at the head", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ updated: arrayPrepend(val("first"), tags) as never })
      .where(({ id }) => id.eq(1))
      .many()
    expect(rows[0].updated).toEqual(["first", "sql", "pg"])
  })
})

describe("arrayCat roundtrip via PGlite", () => {
  it("ARRAY_CAT concatenates two arrays in order", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ merged: arrayCat(tags, arrayLiteral([val("x"), val("y")])) as never })
      .where(({ id }) => id.eq(1))
      .many()
    expect(rows[0].merged).toEqual(["sql", "pg", "x", "y"])
  })
})

describe("arrayLength roundtrip via PGlite", () => {
  it("ARRAY_LENGTH(arr, 1) returns the size of dimension 1", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ n: arrayLength(tags) as never })
      .orderBy("id")
      .many()
    expect(rows).toHaveLength(3)
    // 2, 3, NULL (PG returns NULL for empty arrays in array_length).
    expect(rows[0].n).toBe(2)
    expect(rows[1].n).toBe(3)
    expect(rows[2].n).toBeNull()
  })
})

describe("arrayPositions roundtrip via PGlite", () => {
  it("ARRAY_POSITIONS returns every 1-based index that matches", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ hits: arrayPositions(tags, val("sql")) as never })
      .orderBy("id")
      .many()
    expect(rows).toHaveLength(3)
    // ['sql','pg'] → [1]
    // ['ts','sql','sql'] → [2, 3]
    // [] → []
    expect(rows[0].hits).toEqual([1])
    expect(rows[1].hits).toEqual([2, 3])
    expect(rows[2].hits).toEqual([])
  })
})

describe("arrayPosition roundtrip via PGlite", () => {
  it("ARRAY_POSITION returns the FIRST 1-based match or NULL", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ idx: arrayPosition(tags, val("sql")) as never })
      .orderBy("id")
      .many()
    expect(rows[0].idx).toBe(1)
    expect(rows[1].idx).toBe(2)
    expect(rows[2].idx).toBeNull()
  })

  it("returns NULL when the element is not present", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ idx: arrayPosition(tags, val("does-not-exist")) as never })
      .where(({ id }) => id.eq(1))
      .many()
    expect(rows[0].idx).toBeNull()
  })
})

describe("arrayRemove roundtrip via PGlite", () => {
  it("ARRAY_REMOVE strips every occurrence", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ cleaned: arrayRemove(tags, val("sql")) as never })
      .orderBy("id")
      .many()
    expect(rows[0].cleaned).toEqual(["pg"])
    expect(rows[1].cleaned).toEqual(["ts"])
    expect(rows[2].cleaned).toEqual([])
  })
})

describe("arrayReplace roundtrip via PGlite", () => {
  it("ARRAY_REPLACE swaps every occurrence", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ x: arrayReplace(tags, val("sql"), val("postgres")) as never })
      .orderBy("id")
      .many()
    expect(rows[0].x).toEqual(["postgres", "pg"])
    expect(rows[1].x).toEqual(["ts", "postgres", "postgres"])
    expect(rows[2].x).toEqual([])
  })
})

describe("arrayToString roundtrip via PGlite", () => {
  it("ARRAY_TO_STRING joins with the separator", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ csv: arrayToString(tags, val(",")) as never })
      .orderBy("id")
      .many()
    expect(rows[0].csv).toBe("sql,pg")
    expect(rows[1].csv).toBe("ts,sql,sql")
    expect(rows[2].csv).toBe("")
  })
})

describe("unnest roundtrip via PGlite", () => {
  it("UNNEST expands an array into a set (one row per element)", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ tag: unnest(tags) as never })
      .where(({ id }) => id.eq(1))
      .many()
    // ['sql','pg'] → two rows.
    expect(rows.map((r) => r.tag)).toEqual(["sql", "pg"])
  })

  it("UNNEST on an empty array yields zero rows for that input", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("af_posts")
      .select({ n: unnest(nums) as never })
      .where(({ id }) => id.eq(3))
      .many()
    expect(rows).toHaveLength(0)
  })
})
