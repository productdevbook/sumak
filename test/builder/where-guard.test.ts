import { describe, expect, it } from "vitest"

import { unwrapPredicate } from "../../src/ast/typed-expression.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

/**
 * Runtime guard against the silent-no-op bug where calling
 * `.where("col", "=", val)` (kysely-style three-arg form) was passing
 * the string `"col"` as the predicate, having every following arg
 * discarded by JavaScript's loose call-site, and storing `undefined` in
 * the AST. The printer then emitted a SELECT/UPDATE/DELETE without a
 * WHERE clause — a row-scoped DELETE silently turning into a table
 * wipe. The guard turns that into a loud TypeError at compile time.
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

  describe("typed-select .where()", () => {
    it("callback form works", () => {
      const q = db
        .selectFrom("users")
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).toMatch(/WHERE/)
    })

    it("kysely-style 3-arg form throws instead of silently dropping WHERE", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — kysely-style 3-arg WHERE is not part of sumak's typed API
      expect(() => sel.where("id", "=", 1)).toThrow(/Expression<boolean>/)
    })

    it("passing undefined throws", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — undefined is not a valid predicate
      expect(() => sel.where(undefined)).toThrow(/Got undefined/)
    })
  })

  describe("typed-select .orWhere()", () => {
    it("kysely-style 3-arg form throws", () => {
      const sel = db.selectFrom("users").where(({ id }) => id.eq(1))
      // @ts-expect-error — kysely-style 3-arg WHERE is not part of sumak's typed API
      expect(() => sel.orWhere("name", "=", "ada")).toThrow(/Expression<boolean>/)
    })
  })

  describe("typed-select .having()", () => {
    it("kysely-style 3-arg form throws", () => {
      const sel = db.selectFrom("users").select("id").groupBy("id")
      // @ts-expect-error — kysely-style 3-arg HAVING is not part of sumak's typed API
      expect(() => sel.having("id", ">", 0)).toThrow(/Expression<boolean>/)
    })
  })

  describe("typed-update .where()", () => {
    it("callback form works", () => {
      const q = db
        .update("users")
        .set({ name: "ada" })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).toMatch(/WHERE/)
    })

    it("kysely-style 3-arg form throws", () => {
      const upd = db.update("users").set({ name: "ada" })
      // @ts-expect-error — kysely-style 3-arg WHERE is not part of sumak's typed API
      expect(() => upd.where("id", "=", 1)).toThrow(/Expression<boolean>/)
    })
  })

  describe("typed-delete .where()", () => {
    it("callback form works", () => {
      const q = db
        .deleteFrom("users")
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).toMatch(/WHERE/)
    })

    // The most dangerous case: a row-scoped DELETE silently becoming a
    // table wipe. If anyone ever loosens this guard, this test will
    // remind them why it exists.
    it("kysely-style 3-arg DELETE throws — preventing a silent table wipe", () => {
      const del = db.deleteFrom("users")
      // @ts-expect-error — kysely-style 3-arg WHERE is not part of sumak's typed API
      expect(() => del.where("id", "=", 1)).toThrow(/Expression<boolean>/)
    })
  })
})
