import { describe, expect, it } from "vitest"

import { unwrapPredicate } from "../../src/ast/typed-expression.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

/**
 * The original silent-no-op bug: calling `.where("col", "=", val)`
 * (kysely-style three-arg form) passed `"col"` as the predicate, JS
 * dropped the operator and value, and the printer emitted SQL
 * without a WHERE clause — a row-scoped DELETE silently turning
 * into a table wipe.
 *
 * Two safeguards remain after PR #95 + this PR:
 *
 * 1. The three-arg form is now a real overload (handled by
 *    `where-3-arg.ts`); calls like `.where("id", "=", 1)` produce
 *    valid SQL.
 * 2. Any other shape — bare string, number, undefined, etc. —
 *    still throws through `unwrapPredicate` because the original
 *    silent path (just `unwrap(arg).node` on whatever) is gone.
 */
describe("predicate guard — silent .where() bug", () => {
  const db = sumak({
    dialect: pgDialect(),
    tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
  })

  describe("unwrapPredicate helper", () => {
    it("accepts an Expression and returns its node", () => {
      const q = db
        .selectFrom("users")
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).toContain("WHERE")
      expect(q.params).toEqual([1])
    })

    it("throws on a bare string", () => {
      expect(() => unwrapPredicate("id", ".where()")).toThrow(/Expression<boolean>/)
    })

    it("throws on a number", () => {
      expect(() => unwrapPredicate(42, ".where()")).toThrow(/Got number/)
    })

    it("throws on null", () => {
      expect(() => unwrapPredicate(null, ".where()")).toThrow(/Got null/)
    })

    it("throws on undefined", () => {
      expect(() => unwrapPredicate(undefined, ".where()")).toThrow(/Got undefined/)
    })

    it("accepts a plain { node } object — sql`` template returns these without the brand", () => {
      const ast = { node: { type: "literal", value: 1 } }
      expect(unwrapPredicate(ast, ".where()")).toEqual(ast.node)
    })

    it("throws on an object with a non-AST-shaped node prop", () => {
      expect(() => unwrapPredicate({ node: "not-a-node" }, ".where()")).toThrow(
        /Expression<boolean>/,
      )
    })

    it("error message points at callback form", () => {
      expect(() => unwrapPredicate("id", ".where()")).toThrow(
        /callback form: \.where\(\(\{ col \}\) => col\.eq\(value\)\)/,
      )
    })

    it("truncates long string arg in the message", () => {
      const long = "x".repeat(80)
      try {
        unwrapPredicate(long, ".where()")
        throw new Error("expected throw")
      } catch (e) {
        const msg = (e as Error).message
        expect(msg).toContain("…")
        expect(msg.length).toBeLessThan(200)
      }
    })
  })

  describe("typed-select .where() — string-only / wrong-arity cases still throw", () => {
    // The three-arg `.where("col", "=", val)` form IS supported now
    // (see the kysely-style overload tests). But the original silent
    // failures — one-arg string, two-arg string — must keep throwing.
    // They're not valid kysely overloads either, so we don't lose
    // anything by being strict.

    it(".where('id') — single string arg throws (no silent WHERE drop)", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — single string is not a valid predicate
      expect(() => sel.where("id")).toThrow(/Expression<boolean>/)
    })

    it(".where('id', '=') — two-arg form throws", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — two-arg form is incomplete
      expect(() => sel.where("id", "=")).toThrow(/Expression<boolean>/)
    })

    it("passing undefined throws", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — undefined is not a valid predicate
      expect(() => sel.where(undefined)).toThrow(/Got undefined/)
    })

    it("passing a bare number throws", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — number is not a valid predicate
      expect(() => sel.where(42)).toThrow(/Got number/)
    })
  })

  describe("typed-delete .where() — DELETE row-wipe regression test", () => {
    // The most dangerous variant of the original bug — a typo'd
    // single-string predicate on a DELETE would have silently wiped
    // the table. If anyone ever loosens the guard, this test reminds
    // them why it exists.

    it("callback form works on DELETE", () => {
      const q = db
        .deleteFrom("users")
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).toMatch(/WHERE/)
    })

    it("DELETE with a single string arg throws — preventing table wipe", () => {
      const del = db.deleteFrom("users")
      // @ts-expect-error — single string is not a valid predicate
      expect(() => del.where("id")).toThrow(/Expression<boolean>/)
    })
  })
})
