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
      .select({ u: upper(val("hello")) })
      .compile(p)
    expect(q.sql).toContain("UPPER('hello')")
  })

  it("LOWER()", () => {
    const q = db
      .selectFrom("users")
      .select({ l: lower(val("HELLO")) })
      .compile(p)
    expect(q.sql).toContain("LOWER('HELLO')")
  })

  it("CONCAT()", () => {
    const q = db
      .selectFrom("users")
      .select({ joined: concat(val("a"), val("b"), val("c")) })
      .compile(p)
    expect(q.sql).toContain("CONCAT(")
    expect(q.sql).toContain("'a'")
    expect(q.sql).toContain("'b'")
    expect(q.sql).toContain("'c'")
  })

  it("SUBSTRING()", () => {
    const q = db
      .selectFrom("users")
      .select({ sub: substring(val("hello"), 2, 3) })
      .compile(p)
    expect(q.sql).toContain("SUBSTRING(")
  })

  it("SUBSTRING() without length", () => {
    const q = db
      .selectFrom("users")
      .select({ sub: substring(val("hello"), 2) })
      .compile(p)
    expect(q.sql).toContain("SUBSTRING('hello', 2)")
  })

  it("TRIM()", () => {
    const q = db
      .selectFrom("users")
      .select({ t: trim(val("  hi  ")) })
      .compile(p)
    expect(q.sql).toContain("TRIM(")
  })

  it("LENGTH()", () => {
    const q = db
      .selectFrom("users")
      .select({ len: length(val("hello")) })
      .compile(p)
    expect(q.sql).toContain("LENGTH('hello')")
  })
})

describe("Date/Time functions", () => {
  it("NOW()", () => {
    const q = db.selectFrom("users").select({ ts: now() }).compile(p)
    expect(q.sql).toContain("NOW()")
  })

  it("CURRENT_TIMESTAMP", () => {
    // Printed as a bare SQL:92 keyword (no parens) — portable across
    // pg/mysql/sqlite/mssql. MSSQL specifically rejects CURRENT_TIMESTAMP().
    const q = db.selectFrom("users").select({ ts: currentTimestamp() }).compile(p)
    expect(q.sql).toMatch(/\bCURRENT_TIMESTAMP\b/)
    expect(q.sql).not.toContain("CURRENT_TIMESTAMP()")
  })
})

describe("Numeric functions", () => {
  it("ABS()", () => {
    const q = db
      .selectFrom("users")
      .select({ a: abs(val(-5) as any) })
      .compile(p)
    expect(q.sql).toContain("ABS(")
  })

  it("ROUND()", () => {
    const q = db
      .selectFrom("users")
      .select({ r: round(val(3.14159) as any, 2) })
      .compile(p)
    expect(q.sql).toContain("ROUND(")
  })

  it("ROUND() without precision", () => {
    const q = db
      .selectFrom("users")
      .select({ r: round(val(3.7) as any) })
      .compile(p)
    expect(q.sql).toContain("ROUND(")
  })

  it("CEIL()", () => {
    const q = db
      .selectFrom("users")
      .select({ c: ceil(val(3.2) as any) })
      .compile(p)
    expect(q.sql).toContain("CEIL(")
  })

  it("FLOOR()", () => {
    const q = db
      .selectFrom("users")
      .select({ f: floor(val(3.7) as any) })
      .compile(p)
    expect(q.sql).toContain("FLOOR(")
  })
})

describe("Conditional functions", () => {
  it("NULLIF()", () => {
    const q = db
      .selectFrom("users")
      .select({ n: nullif(val(0) as any, val(0) as any) })
      .compile(p)
    expect(q.sql).toContain("NULLIF(")
  })

  it("GREATEST()", () => {
    const q = db
      .selectFrom("users")
      .select({ g: greatest(val(1) as any, val(2) as any, val(3) as any) })
      .compile(p)
    expect(q.sql).toContain("GREATEST(")
  })

  it("LEAST()", () => {
    const q = db
      .selectFrom("users")
      .select({ l: least(val(1) as any, val(2) as any, val(3) as any) })
      .compile(p)
    expect(q.sql).toContain("LEAST(")
  })
})
