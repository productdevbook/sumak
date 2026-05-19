import { describe, expect, it } from "vitest"

import type { ExpressionNode, FunctionCallNode } from "../../src/ast/nodes.ts"
import { typedCol } from "../../src/ast/typed-expression.ts"
import { Col, jsonValue, val } from "../../src/builder/eb.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { normalizeExpression } from "../../src/normalize/expression.ts"
import { jsonb, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const tables = {
  events: {
    id: serial().primaryKey(),
    body: jsonb(),
    raw: text().notNull(),
  },
}

// Two ways to grab a column ref outside of where-callbacks: the
// untyped `Col` class (accepts a value-only constructor), or
// `typedCol<T>("name")` for a phantom-typed `Expression<T>`. Both
// produce a `column_ref` AST node — `jsonValue` accepts either.
const bodyCol = new Col("body")
const rawCol = new Col("raw")
const bodyExpr = typedCol<unknown>("body")

describe("JSON_VALUE — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("basic shape: JSON_VALUE(col, '$.path')", () => {
    const q = db
      .selectFrom("events")
      .select({ name: jsonValue(bodyCol, "$.name") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_VALUE("body", '$.name')`)
    // Path is inlined as a string literal, not parameterised — the
    // SQL standard expects an inline jsonpath here, not a parameter.
    expect(q.params).toEqual([])
  })

  it("nested path emits doubled-dot form unchanged", () => {
    const q = db
      .selectFrom("events")
      .select({ city: jsonValue(bodyCol, "$.address.city") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_VALUE("body", '$.address.city')`)
  })

  it("RETURNING type appends inside the parens", () => {
    const q = db
      .selectFrom("events")
      .select({ age: jsonValue(bodyCol, "$.age", { returning: "int" }) as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_VALUE("body", '$.age' RETURNING int)`)
  })

  it("RETURNING numeric(10, 2) — precision/scale type", () => {
    const q = db
      .selectFrom("events")
      .select({
        balance: jsonValue(bodyCol, "$.balance", { returning: "numeric(10, 2)" }) as any,
      })
      .compile(p)
    expect(q.sql).toContain(`JSON_VALUE("body", '$.balance' RETURNING numeric(10, 2))`)
  })

  it("RETURNING text", () => {
    const q = db
      .selectFrom("events")
      .select({ name: jsonValue(bodyCol, "$.name", { returning: "text" }) as any })
      .compile(p)
    expect(q.sql).toContain(`RETURNING text`)
  })

  it("works against a TEXT column carrying JSON-as-string", () => {
    const q = db
      .selectFrom("events")
      .select({ name: jsonValue(rawCol, "$.name") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_VALUE("raw", '$.name')`)
  })

  it("accepts a wrapped Expression (typedCol) as the json operand", () => {
    const q = db
      .selectFrom("events")
      .select({ name: jsonValue(bodyExpr, "$.name") as any })
      .compile(p)
    expect(q.sql).toContain(`JSON_VALUE("body", '$.name')`)
  })

  it("accepts a wrapped scalar literal as the json operand", () => {
    const q = db
      .selectFrom("events")
      .select({ k: jsonValue(val('{"a":1}'), "$.a") as any })
      .compile(p)
    // `val()` inlines string literals (no parameter), so both args
    // end up inside the JSON_VALUE() call as inline quoted strings.
    expect(q.sql).toContain("JSON_VALUE(")
    expect(q.sql).toContain(`'$.a'`)
    expect(q.params).toEqual([])
  })
})

describe("JSON_VALUE — MySQL", () => {
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("emits JSON_VALUE on MySQL with backtick quoting", () => {
    const q = db
      .selectFrom("events")
      .select({ name: jsonValue(bodyCol, "$.name") as any })
      .compile(p)
    expect(q.sql).toContain("JSON_VALUE(`body`, '$.name')")
  })

  it("RETURNING SIGNED works on MySQL", () => {
    const q = db
      .selectFrom("events")
      .select({ age: jsonValue(bodyCol, "$.age", { returning: "SIGNED" }) as any })
      .compile(p)
    expect(q.sql).toContain("RETURNING SIGNED")
  })

  it("RETURNING CHAR(50) on MySQL", () => {
    const q = db
      .selectFrom("events")
      .select({ name: jsonValue(bodyCol, "$.name", { returning: "CHAR(50)" }) as any })
      .compile(p)
    expect(q.sql).toContain("RETURNING CHAR(50)")
  })
})

describe("JSON_VALUE — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("emits JSON_VALUE on MSSQL with [bracket] quoting", () => {
    const q = db
      .selectFrom("events")
      .select({ name: jsonValue(bodyCol, "$.name") as any })
      .compile(p)
    expect(q.sql).toContain("JSON_VALUE([body], '$.name')")
  })

  it("RETURNING clause is refused on MSSQL — wrap with CAST instead", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ age: jsonValue(bodyCol, "$.age", { returning: "int" }) as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("MSSQL error message points at the CAST workaround", () => {
    try {
      db.selectFrom("events")
        .select({ age: jsonValue(bodyCol, "$.age", { returning: "int" }) as any })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("JSON_VALUE")
      expect(err.message).toContain("CAST")
    }
  })
})

describe("JSON_VALUE — SQLite refuses", () => {
  const db = sumak({ dialect: sqliteDialect(), tables })
  const p = db.printer()

  it("throws UnsupportedDialectFeatureError on SQLite", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ name: jsonValue(bodyCol, "$.name") as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })

  it("error mentions JSON_VALUE so callers can grep the feature matrix", () => {
    try {
      db.selectFrom("events")
        .select({ name: jsonValue(bodyCol, "$.name") as any })
        .compile(p)
      expect.fail("should have thrown")
    } catch (e) {
      const err = e as Error
      expect(err.message).toContain("JSON_VALUE")
    }
  })

  it("RETURNING variant also throws on SQLite", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ age: jsonValue(bodyCol, "$.age", { returning: "int" }) as any })
        .compile(p),
    ).toThrow(UnsupportedDialectFeatureError)
  })
})

describe("JSON_VALUE — security guards", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("rejects an injection-shaped RETURNING type at print time", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({
          x: jsonValue(bodyCol, "$.x", { returning: "int); DROP TABLE users; --" }) as any,
        })
        .compile(p),
    ).toThrow()
  })

  it("rejects a RETURNING type with embedded quote", () => {
    expect(() =>
      db
        .selectFrom("events")
        .select({ x: jsonValue(bodyCol, "$.x", { returning: "int'" }) as any })
        .compile(p),
    ).toThrow()
  })
})

describe("JSON_VALUE — AST normalize fingerprint distinguishes RETURNING type", () => {
  // Two equality predicates `a = 1` where `a` is JSON_VALUE(body, '$.x'
  // RETURNING int) and JSON_VALUE(body, '$.x' RETURNING text). The
  // normalizer dedupes structurally identical AND clauses via a
  // fingerprint; the two arms must NOT collapse because the SQL types
  // they coerce to differ. (CNF dedup is the only AST consumer of the
  // function_call fingerprint today.)
  const mkEq = (returningType?: string): ExpressionNode => {
    const fn: FunctionCallNode = {
      type: "function_call",
      name: "JSON_VALUE",
      args: [
        { type: "column_ref", column: "body" },
        { type: "literal", value: "$.x" },
      ],
    }
    if (returningType !== undefined) fn.returningType = returningType
    return { type: "binary_op", op: "=", left: fn, right: { type: "literal", value: 1 } }
  }

  it("AND of two JSON_VALUE calls with different RETURNING types does not dedupe", () => {
    const a = mkEq("int")
    const b = mkEq("text")
    const conj: ExpressionNode = { type: "binary_op", op: "AND", left: a, right: b }
    const out = normalizeExpression(conj)
    // Different RETURNING types → both arms survive.
    expect(out.type).toBe("binary_op")
    expect((out as { op: string }).op).toBe("AND")
  })

  it("AND of two identical JSON_VALUE(... RETURNING int) calls collapses", () => {
    const a = mkEq("int")
    const b = mkEq("int")
    const conj: ExpressionNode = { type: "binary_op", op: "AND", left: a, right: b }
    const out = normalizeExpression(conj)
    // Identical fingerprints → CNF dedup collapses to one binary_op.
    expect(out.type).toBe("binary_op")
    expect((out as { op: string }).op).toBe("=")
  })

  it("a JSON_VALUE call with RETURNING and one without are distinct", () => {
    const a = mkEq()
    const b = mkEq("int")
    const conj: ExpressionNode = { type: "binary_op", op: "AND", left: a, right: b }
    const out = normalizeExpression(conj)
    expect(out.type).toBe("binary_op")
    expect((out as { op: string }).op).toBe("AND")
  })
})
