import { describe, expect, it } from "vitest"
import { quoteIdentifier, quoteTableRef } from "../../src/utils/identifier.ts"

describe("quoteIdentifier", () => {
  it("quotes pg identifiers with double quotes", () => {
    expect(quoteIdentifier("name", "pg")).toBe('"name"')
  })

  it("quotes mysql identifiers with backticks", () => {
    expect(quoteIdentifier("name", "mysql")).toBe("`name`")
  })

  it("quotes sqlite identifiers with double quotes", () => {
    expect(quoteIdentifier("name", "sqlite")).toBe('"name"')
  })

  it("escapes double quotes in pg", () => {
    expect(quoteIdentifier('na"me', "pg")).toBe('"na""me"')
  })

  it("escapes backticks in mysql", () => {
    expect(quoteIdentifier("na`me", "mysql")).toBe("`na``me`")
  })

  it("handles empty string", () => {
    expect(quoteIdentifier("", "pg")).toBe('""')
  })

  it("handles reserved words", () => {
    expect(quoteIdentifier("select", "pg")).toBe('"select"')
    expect(quoteIdentifier("select", "mysql")).toBe("`select`")
  })
})

describe("quoteTableRef", () => {
  it("quotes simple table name", () => {
    expect(quoteTableRef("users", "pg")).toBe('"users"')
  })

  it("quotes table with schema", () => {
    expect(quoteTableRef("users", "pg", "public")).toBe('"public"."users"')
  })

  it("quotes table with schema in mysql", () => {
    expect(quoteTableRef("users", "mysql", "mydb")).toBe("`mydb`.`users`")
  })
})
