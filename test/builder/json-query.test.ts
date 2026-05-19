import { describe, expect, it } from "vitest"

import { typedCol } from "../../src/ast/typed-expression.ts"
import { Col, jsonQuery, val } from "../../src/builder/eb.ts"
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

describe("JSON_QUERY — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("basic shape: JSON_QUERY(col, '$.path')", () => {
    const q = db
      .selectFrom("events")
      .select({ addr: jsonQuery(bodyCol, "$.address") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_QUERY("body", '$.address')`)
    // Path is inlined as a string literal, not parameterised — the
    // SQL standard expects an inline jsonpath here, not a parameter.
    expect(q.params).toEqual([])
  })

  it("nested path emits doubled-dot form unchanged", () => {
    const q = db
      .selectFrom("events")
      .select({ city: jsonQuery(bodyCol, "$.address.city") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_QUERY("body", '$.address.city')`)
  })

  it("array element path (bracket notation)", () => {
    const q = db
      .selectFrom("events")
      .select({ first: jsonQuery(bodyCol, "$.tags[0]") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_QUERY("body", '$.tags[0]')`)
  })

  it("RETURNING jsonb appends inside the parens", () => {
    const q = db
      .selectFrom("events")
      .select({ addr: jsonQuery(bodyCol, "$.address", { returning: "jsonb" }) as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_QUERY("body", '$.address' RETURNING jsonb)`)
  })

  it("RETURNING json — alternative JSON type", () => {
    const q = db
      .selectFrom("events")
      .select({ tags: jsonQuery(bodyCol, "$.tags", { returning: "json" }) as any })
      .compile(p)
    expect(q.sql).toContain(`RETURNING json`)
  })

  it("works against a TEXT column carrying JSON-as-string", () => {
    const q = db
      .selectFrom("events")
      .select({ addr: jsonQuery(rawCol, "$.address") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_QUERY("raw", '$.address')`)
  })

  it("accepts a wrapped Expression (typedCol) as the json operand", () => {
    const q = db
      .selectFrom("events")
      .select({ addr: jsonQuery(bodyExpr, "$.address") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_QUERY("body", '$.address')`)
  })

  it("accepts a wrapped scalar literal as the json operand", () => {
    const q = db
      .selectFrom("events")
      .select({ k: jsonQuery(val('{"a":{"b":1}}'), "$.a") as any })
      .compile(p)
    // `val()` inlines string literals (no parameter), so both args
    // end up inside the JSON_QUERY() call as inline quoted strings.
    expect(q.sql).toContain("JSON_QUERY(")
    expect(q.sql).toContain(`'$.a'`)
    expect(q.params).toEqual([])
  })
})

describe("JSON_QUERY — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("emits JSON_QUERY on MSSQL with [bracket] quoting", () => {
    const q = db
      .selectFrom("events")
      .select({ addr: jsonQuery(bodyCol, "$.address") as any })
      .compile(p)
    expect(q.sql).toContain("JSON_QUERY([body], '$.address')")
  })

  it("RETURNING clause is refused on MSSQL — wrap with CAST instead", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ addr: jsonQuery(bodyCol, "$.address", { returning: "nvarchar(max)" }) as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL error message points at the CAST workaround", () => {
    try {
      db.selectFrom("events")
        .select({ addr: jsonQuery(bodyCol, "$.address", { returning: "nvarchar(max)" }) as any })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      // The MSSQL printer reuses the same `returningType` guard as
      // JSON_VALUE — the error mentions JSON_VALUE in its workaround
      // pointer, which is fine: the user-facing message says "wrap
      // with CAST" and that applies to JSON_QUERY identically.
      expect(err.message).toContain("CAST")
    }
  })
})

describe("JSON_QUERY — MySQL refuses", () => {
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("throws UnsupportedDialectFeatureError on MySQL", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ addr: jsonQuery(bodyCol, "$.address") as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error mentions JSON_QUERY so callers can grep the feature matrix", () => {
    try {
      db.selectFrom("events")
        .select({ addr: jsonQuery(bodyCol, "$.address") as any })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("JSON_QUERY")
    }
  })
})

describe("JSON_QUERY — SQLite refuses", () => {
  const db = sumak({ dialect: sqliteDialect(), tables })
  const p = db.printer()

  it("throws UnsupportedDialectFeatureError on SQLite", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ addr: jsonQuery(bodyCol, "$.address") as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error mentions JSON_QUERY so callers can grep the feature matrix", () => {
    try {
      db.selectFrom("events")
        .select({ addr: jsonQuery(bodyCol, "$.address") as any })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("JSON_QUERY")
    }
  })

  it("RETURNING variant also throws on SQLite", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ addr: jsonQuery(bodyCol, "$.address", { returning: "jsonb" }) as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

describe("JSON_QUERY — security guards", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("rejects an injection-shaped RETURNING type at print time", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({
          x: jsonQuery(bodyCol, "$.x", { returning: "jsonb); DROP TABLE users; --" }) as any,
        })
        .compile(p),
    ).toThrow()
  })

  it("rejects a RETURNING type with embedded quote", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ x: jsonQuery(bodyCol, "$.x", { returning: "jsonb'" }) as any })
        .compile(p),
    ).toThrow()
  })
})
