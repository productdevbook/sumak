import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { normalizeStrings } from "../../src/plugin/normalize-strings.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("normalizeStrings", () => {
  describe("INSERT", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        normalizeStrings({
          users: {
            email: ["trim", "lower"],
            name: "trim",
            bio: ["trim", "emptyToNull"],
          },
        }),
      ],
      tables: {
        users: {
          id: serial().primaryKey(),
          email: text().notNull(),
          name: text().notNull(),
          bio: text().nullable(),
        },
      },
    })

    it("applies chained transforms in order (trim then lower)", () => {
      const q = db
        .insertInto("users")
        .values({
          email: "  Alice@Example.com  ",
          name: "Alice",
          bio: "hello",
        })
        .toSQL()
      expect(q.params).toContain("alice@example.com")
      // SQL itself stays clean — no LOWER(…) wrapping.
      expect(q.sql).not.toContain("LOWER")
      expect(q.sql).not.toContain("TRIM")
    })

    it("single-transform string form (trim)", () => {
      const q = db
        .insertInto("users")
        .values({
          email: "a@a",
          name: "Alice  ",
          bio: "hi",
        })
        .toSQL()
      expect(q.params).toContain("Alice")
    })

    it("emptyToNull turns '' into null", () => {
      const q = db
        .insertInto("users")
        .values({
          email: "a@a",
          name: "n",
          bio: "  ",
        })
        .toSQL()
      // trim turns the bio into "", then emptyToNull turns it into null.
      expect(q.params).toContain(null)
      expect(q.params).not.toContain("")
    })

    it("leaves unconfigured columns alone", () => {
      const q = db
        .insertInto("users")
        .values({
          email: "X@X.x",
          name: "  spaced  ", // configured: trim
          bio: "  body  ", // configured: trim+emptyToNull → "body"
        })
        .toSQL()
      expect(q.params).toContain("x@x.x") // email got trim+lower
      expect(q.params).toContain("spaced") // name got trim
      expect(q.params).toContain("body") // bio got trim, still non-empty
    })

    it("preserves param ordering / count when rewriting in place", () => {
      const q = db
        .insertInto("users")
        .values({
          email: "  A@B  ",
          name: "Bob",
          bio: "x",
        })
        .toSQL()
      // No new params are added; the rewrite swaps values in place.
      expect(q.params).toHaveLength(3)
      expect(q.params).toContain("a@b")
      expect(q.params).toContain("Bob")
      expect(q.params).toContain("x")
    })

    it("does not affect a different table", () => {
      const db2 = sumak({
        dialect: pgDialect(),
        plugins: [normalizeStrings({ users: { email: "lower" } })],
        tables: {
          users: { id: serial().primaryKey(), email: text().notNull() },
          posts: { id: serial().primaryKey(), title: text().notNull() },
        },
      })
      const q = db2.insertInto("posts").values({ title: "TITLE" }).toSQL()
      expect(q.params).toContain("TITLE")
    })

    it("non-string values are pass-through (defensive runtime check)", () => {
      // The type checker prevents this at compile-time, but a runtime
      // `as any` could still slip a number through. The plugin must
      // leave it untouched rather than crash on `.toLowerCase`.
      const db2 = sumak({
        dialect: pgDialect(),
        plugins: [normalizeStrings({ orders: { code: "lower" } })],
        tables: {
          orders: { id: serial().primaryKey(), code: integer().notNull() },
        },
      })
      const q = db2
        .insertInto("orders")
        .values({ code: 42 as any })
        .toSQL()
      expect(q.params).toContain(42)
    })

    it("custom function transform", () => {
      const db2 = sumak({
        dialect: pgDialect(),
        plugins: [
          normalizeStrings({
            users: { handle: (v: string) => "@" + v.replaceAll(" ", "_") },
          }),
        ],
        tables: {
          users: { id: serial().primaryKey(), handle: text().notNull() },
        },
      })
      const q = db2.insertInto("users").values({ handle: "alice in chains" }).toSQL()
      expect(q.params).toContain("@alice_in_chains")
    })

    it("custom function returning null becomes SQL NULL parameter", () => {
      const db2 = sumak({
        dialect: pgDialect(),
        plugins: [
          normalizeStrings({
            users: { nick: (v: string) => (v.startsWith("anon") ? null : v) },
          }),
        ],
        tables: {
          users: { id: serial().primaryKey(), nick: text().nullable() },
        },
      })
      const q = db2.insertInto("users").values({ nick: "anonymous" }).toSQL()
      expect(q.params).toContain(null)
    })

    it("upper / trimStart / trimEnd / collapseWhitespace built-ins", () => {
      const db2 = sumak({
        dialect: pgDialect(),
        plugins: [
          normalizeStrings({
            t: {
              shouty: "upper",
              ls: "trimStart",
              rs: "trimEnd",
              ws: "collapseWhitespace",
            },
          }),
        ],
        tables: {
          t: {
            id: serial().primaryKey(),
            shouty: text().notNull(),
            ls: text().notNull(),
            rs: text().notNull(),
            ws: text().notNull(),
          },
        },
      })
      const q = db2
        .insertInto("t")
        .values({
          shouty: "hush",
          ls: "  left",
          rs: "right  ",
          ws: "a   b\tc\n\nd",
        })
        .toSQL()
      expect(q.params).toContain("HUSH")
      expect(q.params).toContain("left")
      expect(q.params).toContain("right")
      expect(q.params).toContain("a b c d")
    })

    it("bulk INSERT (valuesMany) normalises every row", () => {
      const q = db
        .insertInto("users")
        .valuesMany([
          { email: "  A@A  ", name: "n1", bio: "x" },
          { email: "  B@B  ", name: "n2", bio: "y" },
        ])
        .toSQL()
      expect(q.params).toContain("a@a")
      expect(q.params).toContain("b@b")
    })
  })

  describe("UPDATE", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        normalizeStrings({
          users: {
            email: ["trim", "lower"],
            bio: ["trim", "emptyToNull"],
          },
        }),
      ],
      tables: {
        users: {
          id: serial().primaryKey(),
          email: text().notNull(),
          name: text().notNull(),
          bio: text().nullable(),
        },
      },
    })

    it("applies transforms to SET values", () => {
      const q = db
        .update("users")
        .set({ email: "  Bob@EX.com  " })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.params).toContain("bob@ex.com")
    })

    it("emptyToNull turns trimmed '' into null on UPDATE", () => {
      const q = db
        .update("users")
        .set({ bio: "   " })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.params).toContain(null)
    })

    it("unknown column in SET is pass-through", () => {
      const q = db
        .update("users")
        .set({ name: "  Spaced  " })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.params).toContain("  Spaced  ")
    })

    it("unknown table is pass-through", () => {
      const db2 = sumak({
        dialect: pgDialect(),
        plugins: [normalizeStrings({ users: { email: "lower" } })],
        tables: {
          users: { id: serial().primaryKey(), email: text().notNull() },
          posts: { id: serial().primaryKey(), title: text().notNull() },
        },
      })
      const q = db2
        .update("posts")
        .set({ title: "Hi" })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.params).toContain("Hi")
    })
  })

  describe("MERGE", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        normalizeStrings({
          users: {
            email: ["trim", "lower"],
          },
        }),
      ],
      tables: {
        users: {
          id: serial().primaryKey(),
          email: text().notNull(),
        },
        staging: {
          id: serial().primaryKey(),
          email: text().notNull(),
        },
      },
    })

    it("WHEN NOT MATCHED INSERT normalises tuple values", () => {
      const q = db
        .mergeInto("users", {
          source: "staging",
          alias: "s",
          on: ({ target, source }) => target.id.eq(source.id),
        })
        .whenNotMatchedThenInsert({ email: "  X@Y.Z  " })
        .toSQL()
      expect(q.params).toContain("x@y.z")
    })

    it("WHEN MATCHED UPDATE normalises SET values", () => {
      const q = db
        .mergeInto("users", {
          source: "staging",
          alias: "s",
          on: ({ target, source }) => target.id.eq(source.id),
        })
        .whenMatchedThenUpdate({ email: "  Q@Q.Q  " })
        .toSQL()
      expect(q.params).toContain("q@q.q")
    })
  })

  describe("SELECT / DELETE pass-through", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [normalizeStrings({ users: { email: "lower" } })],
      tables: {
        users: {
          id: serial().primaryKey(),
          email: text().notNull(),
        },
      },
    })

    it("SELECT WHERE value is not normalised", () => {
      // The plugin is strictly for write-side value normalisation; if we
      // rewrote SELECT WHERE values, callers querying `WHERE email =
      // 'ALICE@X'` would silently miss the row. (They probably should
      // normalise on the write side and not at all on the read side —
      // but that's the user's call, not the plugin's.)
      const q = db
        .selectFrom("users")
        .select("id")
        .where(({ email }) => email.eq("ALICE@X"))
        .toSQL()
      expect(q.params).toContain("ALICE@X")
    })

    it("DELETE WHERE value is not normalised", () => {
      const q = db
        .deleteFrom("users")
        .where(({ email }) => email.eq("BOB@X"))
        .toSQL()
      expect(q.params).toContain("BOB@X")
    })
  })

  describe("config edge cases", () => {
    it("empty config object is a no-op", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [normalizeStrings({})],
        tables: {
          users: { id: serial().primaryKey(), email: text().notNull() },
        },
      })
      const q = db.insertInto("users").values({ email: "X@X" }).toSQL()
      expect(q.params).toContain("X@X")
    })

    it("emptyToNull alone (no trim) leaves whitespace strings as-is", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [normalizeStrings({ users: { nick: "emptyToNull" } })],
        tables: {
          users: { id: serial().primaryKey(), nick: text().nullable() },
        },
      })
      const q = db.insertInto("users").values({ nick: " " }).toSQL()
      // " " is non-empty, so emptyToNull doesn't fire.
      expect(q.params).toContain(" ")
    })

    it("chain that hits null short-circuits remaining transforms", () => {
      let upperCalls = 0
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          normalizeStrings({
            users: {
              nick: [
                "emptyToNull",
                (v: string) => {
                  upperCalls++
                  return v.toUpperCase()
                },
              ],
            },
          }),
        ],
        tables: {
          users: { id: serial().primaryKey(), nick: text().nullable() },
        },
      })
      const q = db.insertInto("users").values({ nick: "" }).toSQL()
      expect(q.params).toContain(null)
      expect(upperCalls).toBe(0)
    })
  })
})
