import { describe, expect, it } from "vitest"

import { typedCol, typedEq, typedGt, typedGte } from "../../src/ast/typed-expression.ts"
import { ltrim, overlay, position, replace, reverse, rtrim, val } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    body: text().notNull(),
    email: text().notNull(),
    phone: text().notNull(),
  },
}

const body = typedCol<string>("body")
const email = typedCol<string>("email")
const phone = typedCol<string>("phone")
const title = typedCol<string>("title")

// ─── replace ────────────────────────────────────────────────────────────

describe("replace — three-arg substring replace", () => {
  it("PG emits REPLACE(haystack, needle, repl) with inline literals", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ cleaned: replace(body, val("foo"), val("bar")) })
      .compile(db.printer())
    expect(q.sql).toContain(`REPLACE("body", 'foo', 'bar')`)
    // val() produces inline literals (same convention as the regex
    // builders), so no params for constant needle/replacement.
    expect(q.params).toEqual([])
    expect(q.sql).toContain('AS "cleaned"')
  })

  it("MySQL emits REPLACE with backtick identifiers", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: replace(body, val("a"), val("b")) })
      .compile(db.printer())
    expect(q.sql).toContain("REPLACE(`body`, 'a', 'b')")
  })

  it("SQLite emits REPLACE", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: replace(body, val("a"), val("b")) })
      .compile(db.printer())
    expect(q.sql).toContain(`REPLACE("body", 'a', 'b')`)
  })

  it("MSSQL emits REPLACE with square-bracket identifiers", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: replace(body, val("a"), val("b")) })
      .compile(db.printer())
    expect(q.sql).toContain("REPLACE([body], 'a', 'b')")
  })

  it("uppercases REPLACE (STANDARD_FUNCTIONS path)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: replace(title, val("x"), val("y")) })
      .compile(db.printer())
    expect(q.sql).toMatch(/\bREPLACE\(/)
    expect(q.sql).not.toMatch(/\breplace\(/)
  })

  it("escapes single quotes inside the needle/replacement", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: replace(body, val("a'b"), val("c'd")) })
      .compile(db.printer())
    // Standard '' doubling, same as everywhere else in sumak.
    expect(q.sql).toContain(`'a''b'`)
    expect(q.sql).toContain(`'c''d'`)
  })

  it("nests under a WHERE predicate via typedEq", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const cleaned = replace(body, val("\r\n"), val("\n"))
    const q = db
      .selectFrom("posts")
      .selectAll()
      .where(() => typedEq(cleaned, val("ok")))
      .compile(db.printer())
    expect(q.sql).toContain("REPLACE(")
    expect(q.sql).toContain("WHERE")
  })
})

// ─── position ───────────────────────────────────────────────────────────

describe("position — find 1-based index of needle in haystack", () => {
  it("PG emits POSITION(needle IN haystack) with the IN keyword", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ at: position(val("@"), email) })
      .compile(db.printer())
    expect(q.sql).toContain(`POSITION('@' IN "email")`)
    expect(q.sql).not.toContain(`POSITION('@', "email")`)
    expect(q.sql).toContain('AS "at"')
  })

  it("MySQL emits POSITION(needle IN haystack) with backtick identifiers", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ at: position(val("@"), email) })
      .compile(db.printer())
    expect(q.sql).toContain("POSITION('@' IN `email`)")
  })

  it("SQLite emits POSITION(needle IN haystack)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ at: position(val("@"), email) })
      .compile(db.printer())
    expect(q.sql).toContain(`POSITION('@' IN "email")`)
  })

  it("MSSQL rewrites POSITION → CHARINDEX(needle, haystack) with comma args", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ at: position(val("@"), email) })
      .compile(db.printer())
    expect(q.sql).toContain("CHARINDEX('@', [email])")
    expect(q.sql).not.toContain("POSITION(")
  })

  it("PG composes into a WHERE predicate via typedGt (Expression<number>)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const at = position(val("@"), email)
    const q = db
      .selectFrom("posts")
      .selectAll()
      .where(() => typedGt(at, val(0)))
      .compile(db.printer())
    expect(q.sql).toContain("POSITION(")
    expect(q.sql).toContain("> 0")
  })

  it("MSSQL CHARINDEX likewise composes into a WHERE", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const at = position(val("@"), email)
    const q = db
      .selectFrom("posts")
      .selectAll()
      .where(() => typedGt(at, val(0)))
      .compile(db.printer())
    expect(q.sql).toContain("CHARINDEX('@', [email])")
    expect(q.sql).toContain("> 0")
  })

  it("position accepts column-only haystack (no literal)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    // The needle here is itself a column expression — POSITION accepts
    // any string-typed expression.
    const q = db
      .selectFrom("posts")
      .select({ at: position(title, body) })
      .compile(db.printer())
    expect(q.sql).toContain(`POSITION("title" IN "body")`)
  })
})

// ─── overlay ────────────────────────────────────────────────────────────

describe("overlay — replace count chars of target starting at from", () => {
  it("PG emits OVERLAY(target PLACING repl FROM from FOR count)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ masked: overlay(phone, val("***"), 4, 3) })
      .compile(db.printer())
    expect(q.sql).toContain(`OVERLAY("phone" PLACING '***' FROM 4 FOR 3)`)
    expect(q.sql).toContain('AS "masked"')
  })

  it("PG omits FOR when count is undefined", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: overlay(phone, val("X"), 1) })
      .compile(db.printer())
    expect(q.sql).toContain(`OVERLAY("phone" PLACING 'X' FROM 1)`)
    expect(q.sql).not.toContain("FOR")
  })

  it("MySQL 8 emits OVERLAY with standard keywords", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: overlay(phone, val("***"), 4, 3) })
      .compile(db.printer())
    expect(q.sql).toContain("OVERLAY(`phone` PLACING '***' FROM 4 FOR 3)")
  })

  it("MSSQL emits OVERLAY with standard keywords (2017+ accepts it natively)", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: overlay(phone, val("***"), 4, 3) })
      .compile(db.printer())
    expect(q.sql).toContain("OVERLAY([phone] PLACING '***' FROM 4 FOR 3)")
  })

  it("SQLite throws — no native OVERLAY function", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    expect(() =>
      db
        .selectFrom("posts")
        .select({ x: overlay(phone, val("***"), 4, 3) })
        .compile(db.printer()),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("inlines from and count as integer literals (not parameters)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: overlay(phone, val("xy"), 7, 2) })
      .compile(db.printer())
    // Both from + count are inlined as bare integers, no params.
    expect(q.params).toEqual([])
    expect(q.sql).toContain("FROM 7 FOR 2")
  })
})

// ─── ltrim / rtrim ──────────────────────────────────────────────────────

describe("ltrim / rtrim — strip leading / trailing characters", () => {
  it("ltrim 1-arg form emits LTRIM(expr) on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: ltrim(title) })
      .compile(db.printer())
    expect(q.sql).toContain(`LTRIM("title")`)
  })

  it("ltrim 1-arg form emits LTRIM(expr) on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: ltrim(title) })
      .compile(db.printer())
    expect(q.sql).toContain("LTRIM(`title`)")
  })

  it("ltrim 1-arg form emits LTRIM(expr) on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: ltrim(title) })
      .compile(db.printer())
    expect(q.sql).toContain(`LTRIM("title")`)
  })

  it("ltrim 1-arg form emits LTRIM(expr) on MSSQL", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: ltrim(title) })
      .compile(db.printer())
    expect(q.sql).toContain("LTRIM([title])")
  })

  it("ltrim 2-arg form emits LTRIM(expr, chars)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: ltrim(title, val("0 ")) })
      .compile(db.printer())
    expect(q.sql).toContain(`LTRIM("title", '0 ')`)
  })

  it("rtrim 1-arg form emits RTRIM(expr) on PG", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: rtrim(title) })
      .compile(db.printer())
    expect(q.sql).toContain(`RTRIM("title")`)
  })

  it("rtrim 1-arg form emits RTRIM(expr) on MySQL", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: rtrim(title) })
      .compile(db.printer())
    expect(q.sql).toContain("RTRIM(`title`)")
  })

  it("rtrim 1-arg form emits RTRIM(expr) on SQLite", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: rtrim(title) })
      .compile(db.printer())
    expect(q.sql).toContain(`RTRIM("title")`)
  })

  it("rtrim 1-arg form emits RTRIM(expr) on MSSQL", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: rtrim(title) })
      .compile(db.printer())
    expect(q.sql).toContain("RTRIM([title])")
  })

  it("rtrim 2-arg form emits RTRIM(expr, chars)", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: rtrim(title, val(" \t")) })
      .compile(db.printer())
    expect(q.sql).toContain("RTRIM(`title`, ' \t')")
  })

  it("ltrim/rtrim compose with other expressions via typedEq", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .selectAll()
      .where(() => typedEq(ltrim(title), val("hello")))
      .compile(db.printer())
    expect(q.sql).toContain(`LTRIM("title")`)
    expect(q.sql).toContain("WHERE")
  })
})

// ─── reverse ────────────────────────────────────────────────────────────

describe("reverse — character order flip", () => {
  it("PG emits REVERSE(expr)", () => {
    const db = sumak({ dialect: pgDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: reverse(title) })
      .compile(db.printer())
    expect(q.sql).toContain(`REVERSE("title")`)
  })

  it("MySQL emits REVERSE(expr)", () => {
    const db = sumak({ dialect: mysqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: reverse(title) })
      .compile(db.printer())
    expect(q.sql).toContain("REVERSE(`title`)")
  })

  it("SQLite emits REVERSE(expr)", () => {
    const db = sumak({ dialect: sqliteDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: reverse(title) })
      .compile(db.printer())
    expect(q.sql).toContain(`REVERSE("title")`)
  })

  it("MSSQL emits REVERSE(expr)", () => {
    const db = sumak({ dialect: mssqlDialect(), tables })
    const q = db
      .selectFrom("posts")
      .select({ x: reverse(title) })
      .compile(db.printer())
    expect(q.sql).toContain("REVERSE([title])")
  })
})

// ─── Composition ────────────────────────────────────────────────────────

describe("string-manipulation builders compose with other builder pieces", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("replace can be used as an output column alongside col refs", () => {
    const q = db
      .selectFrom("posts")
      .select("title")
      .select({ scrubbed: replace(body, val("a"), val("b")) })
      .compile(p)
    expect(q.sql).toContain('"title"')
    expect(q.sql).toContain("REPLACE(")
  })

  it("position result usable in arithmetic (Expression<number>) via typedGte", () => {
    const at = position(val("."), email)
    const q = db
      .selectFrom("posts")
      .selectAll()
      .where(() => typedGte(at, val(1)))
      .compile(p)
    expect(q.sql).toContain("POSITION(")
    expect(q.sql).toContain(">= 1")
  })

  it("overlay output column alongside col refs", () => {
    const q = db
      .selectFrom("posts")
      .select("title")
      .select({ masked: overlay(phone, val("***"), 4, 3) })
      .compile(p)
    expect(q.sql).toContain('"title"')
    expect(q.sql).toContain("OVERLAY(")
  })

  it("nested: reverse(replace(...))", () => {
    const q = db
      .selectFrom("posts")
      .select({ x: reverse(replace(body, val("a"), val("b"))) })
      .compile(p)
    expect(q.sql).toContain("REVERSE(REPLACE(")
  })
})
