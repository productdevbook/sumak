import { describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { Col, jsonExists, val } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { jsonb, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  events: {
    id: serial().primaryKey(),
    body: jsonb(),
    raw: text().notNull(),
  },
}

const bodyCol = new Col("body")
const rawCol = new Col("raw")
const bodyExpr = typedCol<unknown>("body")

describe("JSON_EXISTS — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("basic shape: JSON_EXISTS(col, '$.path')", () => {
    const q = db
      .selectFrom("events")
      .select({ has: jsonExists(bodyCol, "$.email") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_EXISTS("body", '$.email')`)
    // Path is inlined as a string literal, not parameterised — the
    // SQL standard expects an inline jsonpath here, not a parameter.
    expect(q.params).toEqual([])
  })

  it("nested path", () => {
    const q = db
      .selectFrom("events")
      .select({ has: jsonExists(bodyCol, "$.address.city") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_EXISTS("body", '$.address.city')`)
  })

  it("array element path", () => {
    const q = db
      .selectFrom("events")
      .select({ has: jsonExists(bodyCol, "$.tags[0]") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_EXISTS("body", '$.tags[0]')`)
  })

  it("works in WHERE as a boolean predicate", () => {
    const q = db
      .selectFrom("events")
      .select("id")
      .where(() => jsonExists(bodyCol, "$.email"))
      .compile(p)
    expect(q.sql).toContain(`WHERE JSON_EXISTS("body", '$.email')`)
  })

  it("works against a TEXT column carrying JSON-as-string", () => {
    const q = db
      .selectFrom("events")
      .select({ has: jsonExists(rawCol, "$.x") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_EXISTS("raw", '$.x')`)
  })

  it("accepts a wrapped Expression (typedCol) as the json operand", () => {
    const q = db
      .selectFrom("events")
      .select({ has: jsonExists(bodyExpr, "$.email") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_EXISTS("body", '$.email')`)
  })

  it("accepts a wrapped scalar literal as the json operand", () => {
    const q = db
      .selectFrom("events")
      .select({ k: jsonExists(val('{"a":1}'), "$.a") as any })
      .compile(p)
    // `val()` inlines string literals (no parameter), so both args
    // end up inside the JSON_EXISTS() call as inline quoted strings.
    expect(q.sql).toContain("JSON_EXISTS(")
    expect(q.sql).toContain(`'$.a'`)
    expect(q.params).toEqual([])
  })
})

describe("JSON_EXISTS — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("emits JSON_EXISTS on MSSQL with [bracket] quoting", () => {
    const q = db
      .selectFrom("events")
      .select({ has: jsonExists(bodyCol, "$.email") as any })
      .compile(p)
    expect(q.sql).toContain("JSON_EXISTS([body], '$.email')")
  })
})

describe("JSON_EXISTS — MySQL refuses", () => {
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("throws UnsupportedDialectFeatureError on MySQL", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ has: jsonExists(bodyCol, "$.email") as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error mentions JSON_EXISTS so callers can grep the feature matrix", () => {
    try {
      db.selectFrom("events")
        .select({ has: jsonExists(bodyCol, "$.email") as any })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("JSON_EXISTS")
    }
  })
})

describe("JSON_EXISTS — SQLite refuses", () => {
  const db = sumak({ dialect: sqliteDialect(), tables })
  const p = db.printer()

  it("throws UnsupportedDialectFeatureError on SQLite", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ has: jsonExists(bodyCol, "$.email") as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error mentions JSON_EXISTS so callers can grep the feature matrix", () => {
    try {
      db.selectFrom("events")
        .select({ has: jsonExists(bodyCol, "$.email") as any })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("JSON_EXISTS")
    }
  })
})
