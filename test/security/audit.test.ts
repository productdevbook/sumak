import { afterEach, describe, expect, it, vi } from "vitest"

import { col } from "../../src/ast/expression.ts"
import { and, exists, unsafeRawExpr, unsafeSqlFn, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { findRawNodes, hasRawNodes, setUnsafeWarnHandler } from "../../src/security.ts"
import { sumak } from "../../src/sumak.ts"

afterEach(() => {
  setUnsafeWarnHandler(undefined)
})

describe("setUnsafeWarnHandler", () => {
  it("fires on unsafeRawExpr with kind + argument + stack", () => {
    const events: Array<{ kind: string; argument: string; stack: string }> = []
    setUnsafeWarnHandler((e) => events.push(e))
    unsafeRawExpr("age > 18")
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe("unsafeRawExpr")
    expect(events[0]!.argument).toBe("age > 18")
    expect(typeof events[0]!.stack).toBe("string")
  })

  it("fires on unsafeSqlFn with the function name as argument", () => {
    const events: Array<{ kind: string; argument: string }> = []
    setUnsafeWarnHandler((e) => events.push(e))
    unsafeSqlFn("some_udf", val(1))
    expect(events[0]!.kind).toBe("unsafeSqlFn")
    expect(events[0]!.argument).toBe("some_udf")
  })

  it("truncates long SQL fragments to 200 characters", () => {
    const events: Array<{ argument: string }> = []
    setUnsafeWarnHandler((e) => events.push(e))
    const giant = "x".repeat(1000)
    unsafeRawExpr(giant)
    expect(events[0]!.argument.length).toBeLessThanOrEqual(201) // 200 + ellipsis
    expect(events[0]!.argument.endsWith("…")).toBe(true)
  })

  it("handler exceptions are swallowed — audit bug can't break the query", () => {
    setUnsafeWarnHandler(() => {
      throw new Error("audit boom")
    })
    // The escape hatch must still return a valid Expression.
    const e = unsafeRawExpr("x")
    expect(e).toBeDefined()
  })

  it("no handler, no env var — zero output, zero overhead", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    unsafeRawExpr("x")
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe("findRawNodes / hasRawNodes", () => {
  const db = sumak({
    dialect: pgDialect(),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull(), age: integer().notNull() },
    },
  })

  it("finds zero raw nodes in a plain query", () => {
    const ast = db
      .selectFrom("users")
      .where(({ id }) => id.eq(1))
      .selectAll()
      .build()
    expect(findRawNodes(ast)).toHaveLength(0)
    expect(hasRawNodes(ast)).toBe(false)
  })

  it("surfaces a single unsafeRawExpr inside a WHERE clause", () => {
    setUnsafeWarnHandler(() => {}) // silence warnings during the test
    const ast = db
      .selectFrom("users")
      .where(() => unsafeRawExpr<boolean>("age > 18"))
      .selectAll()
      .build()
    const raws = findRawNodes(ast)
    expect(raws).toHaveLength(1)
    expect(raws[0]!.sql).toBe("age > 18")
    expect(raws[0]!.path).toMatch(/where/)
    expect(hasRawNodes(ast)).toBe(true)
  })

  it("recurses into ANDs, subqueries, and EXISTS", () => {
    setUnsafeWarnHandler(() => {})
    const inner = db
      .selectFrom("users")
      .where(() => unsafeRawExpr<boolean>("name LIKE 'x%'"))
      .selectAll()
      .build()
    const ast = db
      .selectFrom("users")
      .where(() => and(unsafeRawExpr<boolean>("a > 1"), exists(inner)))
      .selectAll()
      .build()
    const raws = findRawNodes(ast)
    // Two explicit unsafeRawExpr + any raw that leaks via the EXISTS
    // subquery's WHERE. Expect ≥ 2.
    expect(raws.length).toBeGreaterThanOrEqual(2)
  })

  it("doesn't misreport unrelated properties as raw", () => {
    const ast = db
      .selectFrom("users")
      .select({ header: val("X-Raw-Header") })
      .build()
    expect(findRawNodes(ast)).toHaveLength(0)
  })
})
