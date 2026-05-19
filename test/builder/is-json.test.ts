import { describe, expect, it } from "vitest"

import type { ExpressionNode, IsJsonNode } from "../../src/ast/nodes.ts"
import { ASTTransformer } from "../../src/ast/transformer.ts"
import { visitNode, type ASTVisitor } from "../../src/ast/visitor.ts"
import { ASTWalker } from "../../src/ast/walker.ts"
import { isJson, val } from "../../src/builder/eb.ts"
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
    payload: text().notNull(), // staging text column carrying JSON
    body: jsonb(),
  },
}

describe("IS JSON predicate — PG", () => {
  const db = sumak({ dialect: pgDialect(), tables })
  const p = db.printer()

  it("Col.isJson() emits (col IS JSON) — bare form, no kind", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson())
    expect(q.compile(p).sql).toContain('("payload" IS JSON)')
  })

  it("Col.isJson({ negate: true }) flips to IS NOT JSON", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson({ negate: true }))
    expect(q.compile(p).sql).toContain('("payload" IS NOT JSON)')
  })

  it("kind: value → IS JSON VALUE", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson({ kind: "value" }))
    expect(q.compile(p).sql).toContain('("payload" IS JSON VALUE)')
  })

  it("kind: scalar → IS JSON SCALAR", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson({ kind: "scalar" }))
    expect(q.compile(p).sql).toContain('("payload" IS JSON SCALAR)')
  })

  it("kind: array → IS JSON ARRAY", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson({ kind: "array" }))
    expect(q.compile(p).sql).toContain('("payload" IS JSON ARRAY)')
  })

  it("kind: object → IS JSON OBJECT", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson({ kind: "object" }))
    expect(q.compile(p).sql).toContain('("payload" IS JSON OBJECT)')
  })

  it("kind + negate → IS NOT JSON OBJECT", () => {
    const q = db
      .selectFrom("events")
      .where(({ payload }) => payload.isJson({ kind: "object", negate: true }))
    expect(q.compile(p).sql).toContain('("payload" IS NOT JSON OBJECT)')
  })

  it("top-level isJson() helper accepts Col and Expression", () => {
    const q1 = db.selectFrom("events").where(({ payload }) => isJson(payload))
    expect(q1.compile(p).sql).toContain('("payload" IS JSON)')

    const q2 = db.selectFrom("events").where(() => isJson(val("{}"), { kind: "object" }))
    const out = q2.compile(p)
    expect(out.sql).toContain("IS JSON OBJECT")
  })
})

describe("IS JSON predicate — MySQL", () => {
  const db = sumak({ dialect: mysqlDialect(), tables })
  const p = db.printer()

  it("emits IS JSON on MySQL", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson())
    expect(q.compile(p).sql).toContain("IS JSON")
  })

  it("emits IS JSON ARRAY on MySQL", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson({ kind: "array" }))
    expect(q.compile(p).sql).toContain("IS JSON ARRAY")
  })
})

describe("IS JSON predicate — MSSQL", () => {
  const db = sumak({ dialect: mssqlDialect(), tables })
  const p = db.printer()

  it("emits IS JSON on MSSQL", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson())
    // MSSQL identifier quoting uses []. The shape we care about is just "IS JSON".
    expect(q.compile(p).sql).toContain("IS JSON")
  })

  it("emits IS NOT JSON VALUE on MSSQL", () => {
    const q = db
      .selectFrom("events")
      .where(({ payload }) => payload.isJson({ kind: "value", negate: true }))
    expect(q.compile(p).sql).toContain("IS NOT JSON VALUE")
  })
})

describe("IS JSON predicate — SQLite refuses", () => {
  const db = sumak({ dialect: sqliteDialect(), tables })
  const p = db.printer()

  it("Col.isJson() throws UnsupportedDialectFeatureError on SQLite", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson())
    expect(() => q.compile(p)).toThrow(UnsupportedDialectFeatureError)
  })

  it("error message references the SQL:2016 feature name", () => {
    const q = db.selectFrom("events").where(({ payload }) => payload.isJson({ kind: "object" }))
    try {
      q.compile(p)
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedDialectFeatureError)
      expect((err as Error).message).toContain("IS JSON")
    }
  })
})

describe("AST traversal — walker / transformer / visitor", () => {
  const baseNode: IsJsonNode = {
    type: "is_json",
    expr: { type: "column_ref", column: "payload" },
    kind: "object",
    negated: false,
  }

  it("walker recurses into expr and preserves identity on no-op", () => {
    const w = new ASTWalker()
    const out = w.visitExpression(baseNode)
    expect(out).toBe(baseNode)
  })

  it("walker rewrites the inner expr via a subclass override", () => {
    class Renamer extends ASTWalker {
      override visitExpression(expr: ExpressionNode): ExpressionNode {
        if (expr.type === "column_ref") return { ...expr, column: "renamed" }
        return super.visitExpression(expr)
      }
    }
    const out = new Renamer().visitExpression(baseNode) as IsJsonNode
    expect(out).not.toBe(baseNode)
    expect(out.type).toBe("is_json")
    expect(out.kind).toBe("object")
    expect(out.negated).toBe(false)
    expect(out.expr.type).toBe("column_ref")
    expect((out.expr as { column: string }).column).toBe("renamed")
  })

  it("transformer descends into is_json children", () => {
    class Track extends ASTTransformer {
      seen: string[] = []
      override transformExpression(expr: ExpressionNode): ExpressionNode {
        if (expr.type === "column_ref") this.seen.push(expr.column)
        return super.transformExpression(expr)
      }
    }
    const t = new Track()
    t.transformExpression(baseNode)
    expect(t.seen).toContain("payload")
  })

  it("visitor dispatches is_json to visitExpression", () => {
    let seen: string | undefined
    const visitor: ASTVisitor<void> = {
      visitSelect: () => undefined,
      visitInsert: () => undefined,
      visitUpdate: () => undefined,
      visitDelete: () => undefined,
      visitMerge: () => undefined,
      visitExpression: (n) => {
        seen = n.type
      },
      visitJoin: () => undefined,
      visitOrderBy: () => undefined,
      visitCTE: () => undefined,
    }
    visitNode(baseNode, visitor)
    expect(seen).toBe("is_json")
  })
})

describe("normalize identity preservation", () => {
  it("normalizeExpression returns the same is_json node when nothing rewrites", () => {
    const node: IsJsonNode = {
      type: "is_json",
      expr: { type: "column_ref", column: "payload" },
      kind: "array",
      negated: true,
    }
    const out = normalizeExpression(node)
    expect(out).toBe(node)
  })

  it("dedup fingerprint distinguishes kind variants", () => {
    // Two AND clauses with different `kind` must not collapse to one.
    const a: IsJsonNode = {
      type: "is_json",
      expr: { type: "column_ref", column: "payload" },
      kind: "array",
      negated: false,
    }
    const b: IsJsonNode = {
      type: "is_json",
      expr: { type: "column_ref", column: "payload" },
      kind: "object",
      negated: false,
    }
    const conj: ExpressionNode = { type: "binary_op", op: "AND", left: a, right: b }
    const out = normalizeExpression(conj)
    // Different kinds → not deduped, AND remains binary
    expect(out.type).toBe("binary_op")
    expect((out as { op: string }).op).toBe("AND")
  })

  it("dedup fingerprint collapses two identical is_json clauses", () => {
    const node: IsJsonNode = {
      type: "is_json",
      expr: { type: "column_ref", column: "payload" },
      kind: "object",
      negated: false,
    }
    const conj: ExpressionNode = { type: "binary_op", op: "AND", left: node, right: node }
    const out = normalizeExpression(conj)
    // Duplicates collapse to a single clause.
    expect(out.type).toBe("is_json")
  })
})
