import { describe, expect, it } from "vitest"

import { UnsupportedCaslOperatorError, ucastToExpressionNode } from "../../src/casl/ucast-to-ast.ts"

// Shape of ucast's FieldCondition / CompoundCondition classes — the
// converter works off duck-typing (see docstring on UcastCondition) so
// plain literals like these are interchangeable with the real classes
// from `@ucast/core`. Tests use literals to avoid taking a dev-dep.
function fc(operator: string, field: string, value: unknown) {
  return { operator, field, value }
}
function cc(operator: string, conditions: any[]) {
  return { operator, value: conditions }
}

describe("ucastToExpressionNode — leaf operators", () => {
  it("eq → binary_op `=` with param", () => {
    const node = ucastToExpressionNode(fc("eq", "authorId", 42))
    expect(node).toEqual({
      type: "binary_op",
      op: "=",
      left: { type: "column_ref", column: "authorId", table: undefined },
      right: { type: "param", index: 0, value: 42 },
    })
  })

  it("eq with null → IS NULL (SQL three-valued trap)", () => {
    // `= NULL` always evaluates UNKNOWN, so a CASL rule written as
    // `{ deletedAt: null }` almost certainly means row-level null
    // check, not literal equality. The converter collapses to IS NULL.
    const node = ucastToExpressionNode(fc("eq", "deletedAt", null))
    expect(node).toEqual({
      type: "is_null",
      expr: { type: "column_ref", column: "deletedAt", table: undefined },
      negated: false,
    })
  })

  it("ne with null → IS NOT NULL", () => {
    const node = ucastToExpressionNode(fc("ne", "deletedAt", null))
    expect(node).toMatchObject({ type: "is_null", negated: true })
  })

  it("ne → binary_op `!=`", () => {
    const node = ucastToExpressionNode(fc("ne", "status", "draft"))
    expect(node).toMatchObject({ type: "binary_op", op: "!=" })
  })

  it.each([
    ["gt", ">"],
    ["gte", ">="],
    ["lt", "<"],
    ["lte", "<="],
  ])("%s → `%s`", (ucastOp, sqlOp) => {
    const node = ucastToExpressionNode(fc(ucastOp, "age", 18))
    expect(node).toMatchObject({ type: "binary_op", op: sqlOp })
  })

  it("in → IN (...) with param list", () => {
    const node = ucastToExpressionNode(fc("in", "status", ["draft", "published"]))
    expect(node).toMatchObject({
      type: "in",
      negated: false,
      values: [
        { type: "param", value: "draft" },
        { type: "param", value: "published" },
      ],
    })
  })

  it("nin → NOT IN (...)", () => {
    const node = ucastToExpressionNode(fc("nin", "status", ["archived"]))
    expect(node).toMatchObject({ type: "in", negated: true })
  })

  it("in with empty array → literal FALSE (dialect-safe)", () => {
    // `col IN ()` is a parse error in some dialects. Collapsing to
    // FALSE keeps the surrounding WHERE well-formed and preserves the
    // "empty set allows nothing" semantics.
    const node = ucastToExpressionNode(fc("in", "status", []))
    expect(node).toEqual({ type: "literal", value: false })
  })

  it("nin with empty array → literal TRUE", () => {
    // Inverted semantics of the above — NOT IN of an empty set matches
    // every row.
    const node = ucastToExpressionNode(fc("nin", "status", []))
    expect(node).toEqual({ type: "literal", value: true })
  })

  it("in rejects non-array value", () => {
    expect(() => ucastToExpressionNode(fc("in", "status", "draft" as any))).toThrow(
      UnsupportedCaslOperatorError,
    )
  })
})

describe("ucastToExpressionNode — compound operators", () => {
  it("and combines children left-associatively", () => {
    const node = ucastToExpressionNode(
      cc("and", [fc("eq", "authorId", 1), fc("eq", "published", true)]),
    )
    expect(node).toMatchObject({
      type: "binary_op",
      op: "AND",
      left: { type: "binary_op", op: "=", left: { column: "authorId" } },
      right: { type: "binary_op", op: "=", left: { column: "published" } },
    })
  })

  it("and with three children produces left-leaning tree", () => {
    // AND is associative; we pick left-leaning to match how sumak's
    // other plugins (multiTenant, etc.) thread filters.
    const node = ucastToExpressionNode(
      cc("and", [fc("eq", "a", 1), fc("eq", "b", 2), fc("eq", "c", 3)]),
    )
    // ((a = 1) AND (b = 2)) AND (c = 3)
    expect(node).toMatchObject({
      type: "binary_op",
      op: "AND",
      right: { type: "binary_op", op: "=", left: { column: "c" } },
      left: {
        type: "binary_op",
        op: "AND",
        left: { type: "binary_op", op: "=", left: { column: "a" } },
        right: { type: "binary_op", op: "=", left: { column: "b" } },
      },
    })
  })

  it("empty and → literal TRUE (no-op)", () => {
    // Defensive: CASL wouldn't emit this, but if it ever does, we want
    // `… WHERE TRUE` not a runtime crash.
    expect(ucastToExpressionNode(cc("and", []))).toEqual({ type: "literal", value: true })
  })

  it("or → binary_op OR", () => {
    const node = ucastToExpressionNode(
      cc("or", [fc("eq", "role", "admin"), fc("eq", "role", "moderator")]),
    )
    expect(node).toMatchObject({ type: "binary_op", op: "OR" })
  })

  it("empty or → literal FALSE", () => {
    expect(ucastToExpressionNode(cc("or", []))).toEqual({ type: "literal", value: false })
  })

  it("not wraps a single child in unary NOT", () => {
    const node = ucastToExpressionNode(cc("not", [fc("eq", "banned", true)]))
    expect(node).toMatchObject({
      type: "unary_op",
      op: "NOT",
      operand: { type: "binary_op", op: "=", left: { column: "banned" } },
    })
  })

  it("not with zero or two+ children throws", () => {
    expect(() => ucastToExpressionNode(cc("not", []))).toThrow(UnsupportedCaslOperatorError)
    expect(() => ucastToExpressionNode(cc("not", [fc("eq", "a", 1), fc("eq", "b", 2)]))).toThrow(
      UnsupportedCaslOperatorError,
    )
  })
})

describe("ucastToExpressionNode — unsupported operators", () => {
  it.each(["regex", "exists", "elemMatch", "all", "size"])(
    "rejects %s with UnsupportedCaslOperatorError",
    (op) => {
      expect(() => ucastToExpressionNode(fc(op, "f", "x"))).toThrow(UnsupportedCaslOperatorError)
    },
  )

  it("rejects an unknown compound operator (e.g. `nor`)", () => {
    // `$nor` is a user-addable operator in CASL (see docs). We don't
    // translate it in v1 — users should either rewrite as NOT(OR(...))
    // in their rules or wait for a nor-aware converter pass.
    expect(() => ucastToExpressionNode(cc("nor", [fc("eq", "a", 1)]))).toThrow(
      UnsupportedCaslOperatorError,
    )
  })

  it("error carries the offending operator name", () => {
    try {
      ucastToExpressionNode(fc("regex", "title", "/^hello/"))
      throw new Error("expected UnsupportedCaslOperatorError")
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedCaslOperatorError)
      expect((e as UnsupportedCaslOperatorError).operator).toBe("regex")
    }
  })
})

describe("ucastToExpressionNode — nested trees", () => {
  it("AND(OR(eq, eq), NOT(eq)) — mixed compound + field", () => {
    // Realistic CASL shape:
    //   can('read', 'Post', { $or: [ { published: true }, { authorId: 1 } ] })
    //   cannot('read', 'Post', { title: { $regex: '[WIP]' } })  ← unsupported, skip
    // Using only supported ops here:
    const node = ucastToExpressionNode(
      cc("and", [
        cc("or", [fc("eq", "published", true), fc("eq", "authorId", 1)]),
        cc("not", [fc("eq", "deleted", true)]),
      ]),
    )
    expect(node.type).toBe("binary_op")
    // left: the OR subtree
    expect((node as any).left).toMatchObject({ type: "binary_op", op: "OR" })
    // right: the NOT subtree
    expect((node as any).right).toMatchObject({ type: "unary_op", op: "NOT" })
  })
})

describe("ucastToExpressionNode — parameterization", () => {
  it("every literal value travels through a param node (no SQL inlining)", () => {
    // Security-critical: the converter must not produce literal nodes
    // for user-supplied values — CASL conditions can carry anything
    // the app puts in them (including attacker-controlled strings via
    // misconfigured rules). Wrapping in `param` forces sumak's
    // printers to use placeholders.
    const node = ucastToExpressionNode(
      cc("and", [fc("eq", "name", "'; DROP TABLE users;--"), fc("in", "id", [1, 2, 3])]),
    )
    // Walk and assert: any non-column, non-literal leaf reachable from
    // the root has type "param".
    const params = collectParams(node)
    expect(params.length).toBe(4)
    expect(params.map((p) => p.value)).toEqual(["'; DROP TABLE users;--", 1, 2, 3])
  })
})

function collectParams(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out
  if (node.type === "param") {
    out.push(node)
    return out
  }
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => collectParams(c, out))
    else if (v && typeof v === "object") collectParams(v, out)
  }
  return out
}
