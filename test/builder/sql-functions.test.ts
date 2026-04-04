import { describe, expect, it } from "vitest"

import {
  abs,
  ceil,
  concat,
  currentTimestamp,
  floor,
  greatest,
  least,
  length,
  lower,
  now,
  nullif,
  round,
  substring,
  trim,
  upper,
  val,
} from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text, integer } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("String functions", () => {
  it("UPPER()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(upper(val("hello")), "u")
      .compile(p)
    expect(q.sql).toContain("UPPER('hello')")
  })

  it("LOWER()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(lower(val("HELLO")), "l")
      .compile(p)
    expect(q.sql).toContain("LOWER('HELLO')")
  })

  it("CONCAT()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(concat(val("a"), val("b"), val("c")), "joined")
      .compile(p)
    expect(q.sql).toContain("CONCAT(")
    expect(q.sql).toContain("'a'")
    expect(q.sql).toContain("'b'")
    expect(q.sql).toContain("'c'")
  })

  it("SUBSTRING()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(substring(val("hello"), 2, 3), "sub")
      .compile(p)
    expect(q.sql).toContain("SUBSTRING(")
  })

  it("SUBSTRING() without length", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(substring(val("hello"), 2), "sub")
      .compile(p)
    expect(q.sql).toContain("SUBSTRING('hello', 2)")
  })

  it("TRIM()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(trim(val("  hi  ")), "t")
      .compile(p)
    expect(q.sql).toContain("TRIM(")
  })

  it("LENGTH()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(length(val("hello")), "len")
      .compile(p)
    expect(q.sql).toContain("LENGTH('hello')")
  })
})

describe("Date/Time functions", () => {
  it("NOW()", () => {
    const q = db.selectFrom("users").selectExpr(now(), "ts").compile(p)
    expect(q.sql).toContain("NOW()")
  })

  it("CURRENT_TIMESTAMP", () => {
    const q = db.selectFrom("users").selectExpr(currentTimestamp(), "ts").compile(p)
    expect(q.sql).toContain("CURRENT_TIMESTAMP()")
  })
})

describe("Numeric functions", () => {
  it("ABS()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(abs(val(-5) as any), "a")
      .compile(p)
    expect(q.sql).toContain("ABS(")
  })

  it("ROUND()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(round(val(3.14159) as any, 2), "r")
      .compile(p)
    expect(q.sql).toContain("ROUND(")
  })

  it("ROUND() without precision", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(round(val(3.7) as any), "r")
      .compile(p)
    expect(q.sql).toContain("ROUND(")
  })

  it("CEIL()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(ceil(val(3.2) as any), "c")
      .compile(p)
    expect(q.sql).toContain("CEIL(")
  })

  it("FLOOR()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(floor(val(3.7) as any), "f")
      .compile(p)
    expect(q.sql).toContain("FLOOR(")
  })
})

describe("Conditional functions", () => {
  it("NULLIF()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(nullif(val(0) as any, val(0) as any), "n")
      .compile(p)
    expect(q.sql).toContain("NULLIF(")
  })

  it("GREATEST()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(greatest(val(1) as any, val(2) as any, val(3) as any), "g")
      .compile(p)
    expect(q.sql).toContain("GREATEST(")
  })

  it("LEAST()", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(least(val(1) as any, val(2) as any, val(3) as any), "l")
      .compile(p)
    expect(q.sql).toContain("LEAST(")
  })
})
