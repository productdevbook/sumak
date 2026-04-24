import { describe, expect, it } from "vitest"

import { all, any, arrayLiteral, some, val } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const schema = {
  users: { id: serial().primaryKey(), role: text().notNull(), age: integer().notNull() },
  admins: { id: integer().primaryKey() },
}

describe("any / all / some + arrayLiteral — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables: schema })

  it("col = ANY(subquery) emits = ANY (SELECT ...)", () => {
    const admins = db.selectFrom("admins").select("id").build()
    const { sql } = db
      .selectFrom("users")
      .where(({ id }) => id.eq(any({ node: { type: "subquery", query: admins } } as any)))
      .selectAll()
      .toSQL()
    expect(sql).toMatch(/=\s*ANY\s*\(\s*SELECT/i)
  })

  it("col = ANY(ARRAY[...]) emits inline array literal", () => {
    const { sql } = db
      .selectFrom("users")
      .where(({ role }) => role.eq(any<string>(arrayLiteral([val("admin"), val("editor")]))))
      .selectAll()
      .toSQL()
    expect(sql).toMatch(/=\s*ANY\s*\(\s*ARRAY\[/i)
    // `val(...)` emits literal nodes that the printer quotes inline.
    expect(sql).toMatch(/'admin'/)
    expect(sql).toMatch(/'editor'/)
  })

  it("col > ALL(ARRAY[...]) renders ALL", () => {
    const { sql } = db
      .selectFrom("users")
      .where(({ age }) => age.gt(all<number>(arrayLiteral([val(18), val(21)]))))
      .selectAll()
      .toSQL()
    expect(sql).toMatch(/>\s*ALL\s*\(\s*ARRAY\[/i)
  })

  it("some() emits SOME as the quantifier token", () => {
    const { sql } = db
      .selectFrom("users")
      .where(({ role }) => role.eq(some<string>(arrayLiteral([val("a")]))))
      .selectAll()
      .toSQL()
    expect(sql).toMatch(/=\s*SOME\s*\(/i)
  })

  it("arrayLiteral([]) emits ARRAY[] — empty array literal", () => {
    const { sql } = db
      .selectFrom("users")
      .select({ tags: arrayLiteral<string>([]) })
      .toSQL()
    expect(sql).toMatch(/ARRAY\[\]/i)
  })
})

describe("MySQL — subquery form only", () => {
  const db = sumak({ dialect: mysqlDialect(), tables: schema })

  it("ANY(subquery) allowed on MySQL", () => {
    const admins = db.selectFrom("admins").select("id").build()
    const { sql } = db
      .selectFrom("users")
      .where(({ id }) => id.eq(any({ node: { type: "subquery", query: admins } } as any)))
      .selectAll()
      .toSQL()
    expect(sql).toMatch(/=\s*ANY\s*\(\s*SELECT/i)
  })

  it("ANY(ARRAY[...]) rejected — array operand is PG-only", () => {
    expect(() =>
      db
        .selectFrom("users")
        .where(({ role }) => role.eq(any<string>(arrayLiteral([val("a")]))))
        .selectAll()
        .toSQL(),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

describe("SQLite — ANY/ALL rejected entirely", () => {
  const db = sumak({ dialect: sqliteDialect(), tables: schema })

  it("any(subquery) throws UnsupportedDialectFeatureError", () => {
    const admins = db.selectFrom("admins").select("id").build()
    expect(() =>
      db
        .selectFrom("users")
        .where(({ id }) => id.eq(any({ node: { type: "subquery", query: admins } } as any)))
        .selectAll()
        .toSQL(),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

describe("MSSQL — ANY/ALL rejected entirely", () => {
  const db = sumak({ dialect: mssqlDialect(), tables: schema })

  it("any(subquery) throws UnsupportedDialectFeatureError", () => {
    const admins = db.selectFrom("admins").select("id").build()
    expect(() =>
      db
        .selectFrom("users")
        .where(({ id }) => id.eq(any({ node: { type: "subquery", query: admins } } as any)))
        .selectAll()
        .toSQL(),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

describe("buildQuantified — operand validation", () => {
  it("accepts subquery / array / param / literal / raw operands", () => {
    expect(() => any(val(1))).not.toThrow()
    expect(() => any(arrayLiteral([val(1)]))).not.toThrow()
  })

  it("rejects operands that aren't any of the allowed forms (e.g. a column ref)", () => {
    expect(() => any({ node: { type: "column_ref", column: "x" } } as any)).toThrow(
      /subquery, array literal, or array param/,
    )
  })
})
