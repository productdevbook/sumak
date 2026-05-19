import { describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { regexpLike, regexpMatches, regexpReplace, regexpSubstr } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { InvalidExpressionError, UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    body: text().notNull(),
    email: text().notNull(),
  },
}

const body = typedCol<string>("body")
const email = typedCol<string>("email")

// ─── regexpReplace ──────────────────────────────────────────────────────

describe("regexpReplace — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits REGEXP_REPLACE(col, pattern, repl) with inline string literals", () => {
    const q = db
      .selectFrom("posts")
      .select({ stripped: regexpReplace(body, "[^a-z]", "") })
      .compile(p)
    expect(q.sql).toContain(`REGEXP_REPLACE("body", '[^a-z]', '')`)
    expect(q.sql).toContain('AS "stripped"')
    // Pattern + replacement are emitted inline, not parameterised.
    expect(q.params).toEqual([])
  })

  it("includes the flags argument when provided", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: regexpReplace(body, "foo", "BAR", "gi") })
      .compile(p)
    expect(q.sql).toContain(`REGEXP_REPLACE("body", 'foo', 'BAR', 'gi')`)
    expect(q.params).toEqual([])
  })

  it("escapes single quotes inside the pattern via the standard '' doubling", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: regexpReplace(body, "a'b", "z") })
      .compile(p)
    // We trust `rawLit` to do the escape — assert the output contains
    // the doubled-quote form, not the raw single quote.
    expect(q.sql).toContain(`'a''b'`)
  })

  it("uppercases the function name (STANDARD_FUNCTIONS path)", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: regexpReplace(body, "a", "b") })
      .compile(p)
    expect(q.sql).toMatch(/REGEXP_REPLACE\(/)
    expect(q.sql).not.toMatch(/regexp_replace\(/)
  })
})

describe("regexpReplace — cross-dialect", () => {
  it("MySQL emits REGEXP_REPLACE with backtick identifiers", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: regexpReplace(body, "x", "y") })
      .compile(db.printer())
    expect(q.sql).toContain("REGEXP_REPLACE(`body`, 'x', 'y')")
  })

  it("SQLite emits REGEXP_REPLACE (requires the regexp extension at runtime)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: regexpReplace(body, "x", "y") })
      .compile(db.printer())
    expect(q.sql).toContain(`REGEXP_REPLACE("body", 'x', 'y')`)
  })

  it("MSSQL throws — no native regex replace", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: regexpReplace(body, "x", "y") })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── regexpLike ─────────────────────────────────────────────────────────

describe("regexpLike — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits REGEXP_LIKE(col, pattern) as a boolean expression", () => {
    const q = db
      .selectFrom("posts")
      .where(() => regexpLike(email, "^[^@]+@[^@]+$"))
      .compile(p)
    expect(q.sql).toContain(`REGEXP_LIKE("email", '^[^@]+@[^@]+$')`)
    expect(q.sql).toContain("WHERE")
    expect(q.params).toEqual([])
  })

  it("includes flags when provided", () => {
    const q = db
      .selectFrom("posts")
      .where(() => regexpLike(body, "foo", "i"))
      .compile(p)
    expect(q.sql).toContain(`REGEXP_LIKE("body", 'foo', 'i')`)
  })
})

describe("regexpLike — cross-dialect", () => {
  it("MySQL emits REGEXP_LIKE", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .where(() => regexpLike(body, "x"))
      .compile(db.printer())
    expect(q.sql).toContain("REGEXP_LIKE(`body`, 'x')")
  })

  it("SQLite throws — no REGEXP_LIKE function (use the REGEXP operator)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    expect(() =>
      db
        .selectFrom("posts")
        .where(() => regexpLike(body, "x"))
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL throws — no regex at all", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    expect(() =>
      db
        .selectFrom("posts")
        .where(() => regexpLike(body, "x"))
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── regexpMatches (PG-only) ────────────────────────────────────────────

describe("regexpMatches — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits REGEXP_MATCHES(col, pattern)", () => {
    const q = db
      .selectFrom("posts")
      .select({ urls: regexpMatches(body, "https?://[^ ]+") })
      .compile(p)
    expect(q.sql).toContain(`REGEXP_MATCHES("body", 'https?://[^ ]+')`)
    expect(q.params).toEqual([])
  })

  it("emits REGEXP_MATCHES(col, pattern, flags) with the 'g' flag", () => {
    const q = db
      .selectFrom("posts")
      .select({ urls: regexpMatches(body, "https?://[^ ]+", "g") })
      .compile(p)
    expect(q.sql).toContain(`REGEXP_MATCHES("body", 'https?://[^ ]+', 'g')`)
  })

  it("doubles backslashes in the pattern (sumak's literal-escape policy)", () => {
    // `\d` from JS -> `\\d` in SQL after escapeStringLiteral. The
    // user is responsible for choosing a regex syntax that
    // round-trips through this policy — PG's `[[:digit:]]` or a bare
    // `[0-9]` survive intact, `\d` does not.
    const q = db
      .selectFrom("posts")
      .select({ urls: regexpMatches(body, "\\d") })
      .compile(p)
    // The actual SQL emit has two literal backslashes:
    expect(q.sql).toContain(`REGEXP_MATCHES("body", '\\\\d')`)
  })
})

describe("regexpMatches — non-PG dialects throw", () => {
  it.each([
    ["mysql", mysqlDialect()] as const,
    ["sqlite", sqliteDialect()] as const,
    ["mssql", mssqlDialect()] as const,
  ])("throws UnsupportedDialectFeatureError on %s", (_name, dialect) => {
    const db = sumak({ dialect, tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: regexpMatches(body, "x") })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── regexpSubstr ───────────────────────────────────────────────────────

describe("regexpSubstr — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("emits REGEXP_SUBSTR(col, pattern) for the bare form", () => {
    const q = db
      .selectFrom("posts")
      .select({ first: regexpSubstr(body, "[0-9]+") })
      .compile(p)
    expect(q.sql).toContain(`REGEXP_SUBSTR("body", '[0-9]+')`)
    expect(q.params).toEqual([])
  })

  it("includes position + occurrence when provided", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: regexpSubstr(body, "[0-9]+", 1, 2) })
      .compile(p)
    expect(q.sql).toContain(`REGEXP_SUBSTR("body", '[0-9]+', 1, 2)`)
  })

  it("includes the flags trailing arg when occurrence is also set", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: regexpSubstr(body, "abc", 1, 1, "i") })
      .compile(p)
    expect(q.sql).toContain(`REGEXP_SUBSTR("body", 'abc', 1, 1, 'i')`)
  })

  it("rejects flags without position+occurrence (engines require positional args)", () => {
    expect(() => regexpSubstr(body, "abc", 1, undefined, "i")).toThrow(InvalidExpressionError)
    expect(() => regexpSubstr(body, "abc", undefined, undefined, "i")).toThrow(
      InvalidExpressionError,
    )
  })

  it("rejects occurrence without position", () => {
    expect(() => regexpSubstr(body, "abc", undefined, 1)).toThrow(InvalidExpressionError)
  })
})

describe("regexpSubstr — cross-dialect", () => {
  it("MySQL emits REGEXP_SUBSTR", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: regexpSubstr(body, "x") })
      .compile(db.printer())
    expect(q.sql).toContain("REGEXP_SUBSTR(`body`, 'x')")
  })

  it("SQLite throws — no REGEXP_SUBSTR function", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: regexpSubstr(body, "x") })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL throws — no regex at all", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: regexpSubstr(body, "x") })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

// ─── Composition ────────────────────────────────────────────────────────

describe("regex builders compose with other builder pieces", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("regexpReplace nests inside a WHERE comparison", () => {
    // Just an emit-level check that the regex function shows up where
    // we put it; semantic comparison ergonomics are covered by Col.
    const q = db
      .selectFrom("posts")
      .where(() => regexpLike(body, "foo|bar"))
      .compile(p)
    expect(q.sql).toContain("REGEXP_LIKE")
    expect(q.sql).toContain("foo|bar")
  })

  it("regexpReplace can be used as an output column alongside col refs", () => {
    const q = db
      .selectFrom("posts")
      .select("title")
      .select({ scrubbed: regexpReplace(body, "[0-9]+", "###") })
      .compile(p)
    expect(q.sql).toContain('"title"')
    expect(q.sql).toContain("REGEXP_REPLACE")
    expect(q.sql).toContain("'[0-9]+'")
    expect(q.sql).toContain("'###'")
  })
})
