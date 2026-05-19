import { describe, expect, it } from "vitest"

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
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { arr } from "../../src/ns/arr.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// Schema only carries scalar columns — PG arrays have no first-class
// schema-side builder yet. The builder API takes plain `Expression<T[]>`,
// and `typedCol<string[]>(...)` is the canonical way to lift a TEXT[]
// column for these tests. The emit-level assertions don't care about the
// physical column type; what matters is that the function-call shape and
// dialect-gating come out correct.
const tables = {
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    // Stored as TEXT[] / INT[] on PG. The schema-side type is text() /
    // integer() because the column factories are scalar-only at the
    // moment; nothing in this file consumes the inferred TS type, so the
    // mismatch is harmless.
    tags: text().notNull(),
    nums: integer().notNull(),
  },
}

const tags = typedCol<string[]>("tags")
const nums = typedCol<number[]>("nums")

// ─── arrayAppend ─────────────────────────────────────────────────────────

describe("arrayAppend — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_APPEND(arr, element) — element from val() is inlined", () => {
    const q = db
      .selectFrom("posts")
      .select({ updated: arrayAppend(tags, val("new")) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_APPEND("tags", 'new')`)
    expect(q.sql).toContain('AS "updated"')
    // val() emits an inline literal, not a parameter.
    expect(q.params).toEqual([])
  })

  it("uppercases the function name (STANDARD_FUNCTIONS path)", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: arrayAppend(tags, val("x")) })
      .compile(p)
    expect(q.sql).toMatch(/ARRAY_APPEND\(/)
    expect(q.sql).not.toMatch(/array_append\(/)
  })

  it("composes with another array function as the inner array", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: arrayAppend(arrayAppend(tags, val("a")), val("b")) })
      .compile(p)
    expect(q.sql).toMatch(/ARRAY_APPEND\(ARRAY_APPEND\("tags",.+?\),.+?\)/)
  })
})

describe("arrayAppend — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws UnsupportedDialectFeatureError on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayAppend(tags, val("x")) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── arrayPrepend ────────────────────────────────────────────────────────

describe("arrayPrepend — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_PREPEND(element, arr) — note the reversed arg order", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: arrayPrepend(val("first"), tags) })
      .compile(p)
    // The element is the first argument, the array is second.
    expect(q.sql).toContain(`ARRAY_PREPEND('first', "tags")`)
    expect(q.params).toEqual([])
  })
})

describe("arrayPrepend — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayPrepend(val("x"), tags) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── arrayCat ────────────────────────────────────────────────────────────

describe("arrayCat — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_CAT(arr1, arr2)", () => {
    const q = db
      .selectFrom("posts")
      .select({ merged: arrayCat(tags, arrayLiteral([val("a"), val("b")])) })
      .compile(p)
    expect(q.sql).toMatch(/ARRAY_CAT\("tags",\s*ARRAY\[/)
    expect(q.sql).toContain('AS "merged"')
  })
})

describe("arrayCat — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    // Use two `typedCol`-style PG-array refs to dodge the
    // ARRAY[...]-literal feature gate on non-PG dialects (the ArrayExpr
    // printer also refuses there). We only want to assert that the
    // function-name gate fires first.
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayCat(tags, nums as unknown as typeof tags) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── arrayLength ─────────────────────────────────────────────────────────

describe("arrayLength — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_LENGTH(arr, 1) with the default dimension", () => {
    const q = db
      .selectFrom("posts")
      .select({ n: arrayLength(tags) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_LENGTH("tags", 1)`)
    // Dimension is inlined as a literal, not parameterised.
    expect(q.params).toEqual([])
  })

  it("emits the second dimension when passed explicitly", () => {
    const matrix = typedCol<number[][]>("matrix")
    const q = db
      .selectFrom("posts")
      .select({ rows: arrayLength(matrix, 2) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_LENGTH("matrix", 2)`)
  })
})

describe("arrayLength — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayLength(tags) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── arrayPositions ──────────────────────────────────────────────────────

describe("arrayPositions — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_POSITIONS(arr, element)", () => {
    const q = db
      .selectFrom("posts")
      .select({ hits: arrayPositions(tags, val("sql")) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_POSITIONS("tags", 'sql')`)
    expect(q.params).toEqual([])
  })
})

describe("arrayPositions — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayPositions(tags, val("x")) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── arrayPosition ───────────────────────────────────────────────────────

describe("arrayPosition — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_POSITION(arr, element)", () => {
    const q = db
      .selectFrom("posts")
      .select({ idx: arrayPosition(tags, val("sql")) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_POSITION("tags", 'sql')`)
    expect(q.params).toEqual([])
  })
})

describe("arrayPosition — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayPosition(tags, val("x")) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── arrayRemove ─────────────────────────────────────────────────────────

describe("arrayRemove — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_REMOVE(arr, element)", () => {
    const q = db
      .selectFrom("posts")
      .select({ cleaned: arrayRemove(tags, val("draft")) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_REMOVE("tags", 'draft')`)
    expect(q.params).toEqual([])
  })
})

describe("arrayRemove — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayRemove(tags, val("x")) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── arrayReplace ────────────────────────────────────────────────────────

describe("arrayReplace — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_REPLACE(arr, find, replacement)", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: arrayReplace(tags, val("old"), val("new")) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_REPLACE("tags", 'old', 'new')`)
    expect(q.params).toEqual([])
  })
})

describe("arrayReplace — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayReplace(tags, val("a"), val("b")) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── arrayToString ───────────────────────────────────────────────────────

describe("arrayToString — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits ARRAY_TO_STRING(arr, sep) without the optional null-string", () => {
    const q = db
      .selectFrom("posts")
      .select({ csv: arrayToString(tags, val(",")) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_TO_STRING("tags", ',')`)
    expect(q.params).toEqual([])
  })

  it("includes the third null-string arg when provided", () => {
    const q = db
      .selectFrom("posts")
      .select({ csv: arrayToString(tags, val(","), val("NULL")) })
      .compile(p)
    expect(q.sql).toContain(`ARRAY_TO_STRING("tags", ',', 'NULL')`)
    expect(q.params).toEqual([])
  })
})

describe("arrayToString — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: arrayToString(tags, val(",")) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── unnest ──────────────────────────────────────────────────────────────

describe("unnest — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits UNNEST(arr) as a SELECT projection", () => {
    const q = db
      .selectFrom("posts")
      .select({ tag: unnest(tags) })
      .compile(p)
    expect(q.sql).toContain(`UNNEST("tags")`)
    expect(q.sql).toContain('AS "tag"')
  })

  it("uppercases UNNEST (STANDARD_FUNCTIONS path)", () => {
    const q = db
      .selectFrom("posts")
      .select({ tag: unnest(tags) })
      .compile(p)
    expect(q.sql).toMatch(/UNNEST\(/)
    expect(q.sql).not.toMatch(/unnest\(/)
  })
})

describe("unnest — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: unnest(tags) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── `arr` namespace surface ─────────────────────────────────────────────

describe("arr.* namespace mirrors the bare exports", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("arr.append === arrayAppend", () => {
    expect(arr.append).toBe(arrayAppend)
  })

  it("arr.unnest === unnest", () => {
    expect(arr.unnest).toBe(unnest)
  })

  it("arr.length / arr.toString / arr.cat work as projections", () => {
    const q = db
      .selectFrom("posts")
      .select({
        n: arr.length(tags),
        csv: arr.toString(tags, val("|")),
        merged: arr.cat(tags, arrayLiteral([val("z")])),
      })
      .compile(p)
    expect(q.sql).toContain("ARRAY_LENGTH")
    expect(q.sql).toContain("ARRAY_TO_STRING")
    expect(q.sql).toContain("ARRAY_CAT")
  })
})

// ─── Composition / interop with operators ────────────────────────────────

describe("array function builders compose with the @>/<@/&& operators", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("uses ARRAY_APPEND output as the RHS of @>", () => {
    const q = db
      .selectFrom("posts")
      .selectAll()
      .where(() => arr.contains(tags, arrayAppend(tags, val("extra"))))
      .compile(p)
    expect(q.sql).toContain("@>")
    expect(q.sql).toContain("ARRAY_APPEND")
  })
})
