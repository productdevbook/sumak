import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

/**
 * Kysely-style three-arg `.where("col", "op", val)` overload.
 * Same operator strings as kysely so users coming from there get the
 * shape they expect; same AST shape as the callback form so plugins
 * and the optimizer see no difference.
 *
 * Each scenario asserts both that the SQL came out, and that the
 * generated SQL is identical (modulo cosmetic differences) to the
 * callback form — the point of the overload is to be a typing-time
 * shortcut, not a different code path.
 */
describe(".where(col, op, val) — kysely-style three-arg overload", () => {
  const db = sumak({
    dialect: pgDialect(),
    tables: {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(),
        age: integer().nullable(),
        deleted_at: timestamp().nullable(),
      },
    },
  })

  describe("comparison operators", () => {
    it.each([
      ["=", 1, /"id" = \$1/],
      ["==", 1, /"id" = \$1/],
      ["!=", 1, /"id" != \$1/],
      ["<>", 1, /"id" != \$1/],
      ["<", 5, /"id" < \$1/],
      ["<=", 5, /"id" <= \$1/],
      [">", 5, /"id" > \$1/],
      [">=", 5, /"id" >= \$1/],
    ] as const)("supports %s", (op, val, sqlPattern) => {
      const q = db.selectFrom("users").where("id", op, val).toSQL()
      expect(q.sql).toMatch(sqlPattern)
      expect(q.params).toEqual([val])
    })
  })

  describe("string pattern operators", () => {
    it.each([
      ["like", /LIKE/],
      ["not like", /NOT LIKE/],
      ["ilike", /ILIKE/],
      ["not ilike", /NOT ILIKE/],
    ] as const)("supports %s", (op, sqlPattern) => {
      const q = db.selectFrom("users").where("name", op, "%alice%").toSQL()
      expect(q.sql).toMatch(sqlPattern)
      expect(q.params).toEqual(["%alice%"])
    })

    it("like with non-string RHS throws", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — number RHS not allowed for like
      expect(() => sel.where("name", "like", 42)).toThrow(/string RHS/)
    })
  })

  describe("list operators", () => {
    it("in with primitive array", () => {
      const q = db.selectFrom("users").where("id", "in", [1, 2, 3]).toSQL()
      expect(q.sql).toMatch(/"id" IN \(\$1, \$2, \$3\)/)
      expect(q.params).toEqual([1, 2, 3])
    })

    it("not in with primitive array", () => {
      const q = db.selectFrom("users").where("id", "not in", [9, 10]).toSQL()
      expect(q.sql).toMatch(/"id" NOT IN \(\$1, \$2\)/)
      expect(q.params).toEqual([9, 10])
    })

    it("in with non-array RHS throws", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — string RHS not allowed for in
      expect(() => sel.where("id", "in", 1)).toThrow(/array RHS/)
    })
  })

  describe("null operators", () => {
    it("is null", () => {
      const q = db.selectFrom("users").where("deleted_at", "is", null).toSQL()
      expect(q.sql).toMatch(/"deleted_at" IS NULL/)
      expect(q.params).toEqual([])
    })

    it("is not null", () => {
      const q = db.selectFrom("users").where("deleted_at", "is not", null).toSQL()
      expect(q.sql).toMatch(/"deleted_at" IS NOT NULL/)
      expect(q.params).toEqual([])
    })

    it("'is' with non-null RHS throws", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — only null is valid for 'is'
      expect(() => sel.where("deleted_at", "is", 1)).toThrow(/null RHS/)
    })

    it("'is not' with non-null RHS throws", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — only null is valid for 'is not'
      expect(() => sel.where("deleted_at", "is not", 0)).toThrow(/null RHS/)
    })
  })

  describe("AST equivalence with callback form", () => {
    // Both forms must produce identical SQL + params so plugins and the
    // optimizer see a single canonical AST shape. If these diverge,
    // a perf regression on one form would silently miss the other.
    it("string form === callback form for =", () => {
      const a = db.selectFrom("users").where("id", "=", 1).toSQL()
      const b = db
        .selectFrom("users")
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(a.sql).toBe(b.sql)
      expect(a.params).toEqual(b.params)
    })

    it("string form === callback form for in", () => {
      const a = db.selectFrom("users").where("id", "in", [1, 2, 3]).toSQL()
      const b = db
        .selectFrom("users")
        .where(({ id }) => id.in([1, 2, 3]))
        .toSQL()
      expect(a.sql).toBe(b.sql)
      expect(a.params).toEqual(b.params)
    })

    it("string form === callback form for is null", () => {
      const a = db.selectFrom("users").where("deleted_at", "is", null).toSQL()
      const b = db
        .selectFrom("users")
        .where(({ deleted_at }) => deleted_at.isNull())
        .toSQL()
      expect(a.sql).toBe(b.sql)
    })
  })

  describe("chained .where().where()", () => {
    it("string-form chain ANDs predicates", () => {
      const q = db.selectFrom("users").where("id", ">", 0).where("name", "=", "ada").toSQL()
      expect(q.sql).toMatch(/"id" > \$1.*AND.*"name" = \$2/s)
      expect(q.params).toEqual([0, "ada"])
    })

    it("mix string and callback in a chain", () => {
      const q = db
        .selectFrom("users")
        .where("id", ">", 0)
        .where(({ name }) => name.like("a%"))
        .toSQL()
      expect(q.sql).toMatch(/AND/)
      expect(q.params).toEqual([0, "a%"])
    })
  })

  describe("orWhere three-arg form", () => {
    it("orWhere uses string form", () => {
      const q = db.selectFrom("users").where("id", "=", 1).orWhere("name", "=", "ada").toSQL()
      expect(q.sql).toMatch(/OR/)
      expect(q.params).toEqual([1, "ada"])
    })
  })

  describe("having three-arg form", () => {
    it("having uses string form", () => {
      const q = db.selectFrom("users").select("id").groupBy("id").having("id", ">", 0).toSQL()
      expect(q.sql).toMatch(/HAVING.*"id" > \$1/s)
      expect(q.params).toEqual([0])
    })
  })

  describe("UPDATE / DELETE three-arg form", () => {
    it("UPDATE where(col, op, val)", () => {
      const q = db.update("users").set({ name: "ada" }).where("id", "=", 1).toSQL()
      expect(q.sql).toMatch(/UPDATE.*WHERE.*"id" = \$2/s)
      // params: ada (SET), 1 (WHERE)
      expect(q.params).toEqual(["ada", 1])
    })

    it("DELETE where(col, op, val) — the silent-wipe regression case", () => {
      // This is the exact call that, before PR #95's guard, was
      // silently turning into `DELETE FROM users`. Now it's a real
      // overload and produces the correct SQL.
      const q = db.deleteFrom("users").where("id", "=", 1).toSQL()
      expect(q.sql).toMatch(/DELETE FROM "users" WHERE.*"id" = \$1/s)
      expect(q.params).toEqual([1])
    })

    it("DELETE where(col, 'in', [...])", () => {
      const q = db.deleteFrom("users").where("id", "in", [1, 2, 3]).toSQL()
      expect(q.sql).toMatch(/DELETE FROM "users" WHERE.*IN/s)
      expect(q.params).toEqual([1, 2, 3])
    })
  })

  describe("unknown operator", () => {
    it("throws on a bogus operator string", () => {
      const sel = db.selectFrom("users")
      // @ts-expect-error — "bogus" is not a valid op
      expect(() => sel.where("id", "bogus", 1)).toThrow(/unknown operator/)
    })
  })
})
