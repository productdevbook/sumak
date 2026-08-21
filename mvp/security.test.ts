import { describe, expect, it } from "vitest"

import { db, int, lit, mysql, t, text } from "./index.ts"
import { make } from "./sql.ts"

const schema = { users: { id: int(), name: text() } }
const pgDb = db(schema)
const myDb = db(schema, mysql)
const q = make(schema)

describe("a value cannot become sql", () => {
  it("the type system refuses a bare value where a predicate expects one", () => {
    // @ts-expect-error user input has to be a parameter; writing it into the text
    // is only possible through lit(), which is a deliberate, greppable act
    pgDb.from("users").where((c) => c.users.name.eq("x' OR '1'='1"))
  })

  it("a parameter never reaches the text", () => {
    const built = pgDb
      .from("users")
      .params(t.text)
      .where((c, [name]) => c.users.name.eq(name))
      .build()

    expect(built.sql).toBe('SELECT * FROM "users" WHERE ("users"."name" = $1)')
    expect(built.bind(["x' OR '1'='1"])).toEqual(["x' OR '1'='1"])
  })

  it("the literal form has no place a value could be spliced into", () => {
    const built = q("SELECT id FROM users WHERE name = $1", t.text)

    expect(built.sql).toBe("SELECT id FROM users WHERE name = $1")
    expect(built.bind(["x' OR '1'='1"])).toEqual(["x' OR '1'='1"])
  })
})

describe("lit is the only way into the text, and it escapes", () => {
  it("doubles the quote", () => {
    const built = pgDb
      .from("users")
      .where((c) => c.users.name.eq(lit("O'Brien")))
      .build()

    expect(built.sql).toContain("'O''Brien'")
  })

  it("doubles the backslash, which mysql reads as an escape character", () => {
    const built = myDb
      .from("users")
      .where((c) => c.users.name.eq(lit("\\' OR 1=1 -- ")))
      .build()

    expect(built.sql).toContain("'\\\\'' OR 1=1 -- '")
    expect(built.sql).not.toContain("'\\''")
  })

  it("refuses a number it cannot write", () => {
    expect(() => pgDb.from("users").limit(Number.POSITIVE_INFINITY).build()).toThrow(/cannot emit/)
  })
})

describe("identifiers come from the schema", () => {
  it("a column outside the schema cannot be written", () => {
    // @ts-expect-error role is not a column of users, so mass assignment from a
    // request body cannot name it
    pgDb.insertInto("users").values(() => [{ role: lit("admin") }])
  })

  it("quoting doubles a quote rather than closing it", () => {
    const built = pgDb
      .insertInto("users")
      .values(() => [{ 'a" , "b': lit(1) } as never])
      .build()

    expect(built.sql).toContain('"a"" , ""b"')
    expect(built.sql).not.toContain('"a" , "b"')
  })
})
