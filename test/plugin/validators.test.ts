import { PGlite } from "@electric-sql/pglite"
import { describe, expect, it } from "vitest"

import { now } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { ValidationError } from "../../src/errors.ts"
import { validators } from "../../src/plugin/validators.ts"
import { integer, serial, text, timestamptz } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

describe("validators plugin", () => {
  describe("INSERT", () => {
    it("single validator passes for a valid value", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: (v) =>
                (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || "invalid email",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      const q = db.insertInto("users").values({ email: "alice@example.com" }).toSQL()
      expect(q.params).toContain("alice@example.com")
    })

    it("single validator throws ValidationError on invalid value", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: (v) =>
                (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || "invalid email",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      expect(() => db.insertInto("users").values({ email: "not-an-email" }).toSQL()).toThrow(
        ValidationError,
      )
    })

    it("error message includes table + column + validator-supplied message", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: (v) =>
                (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || "invalid email",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      try {
        db.insertInto("users").values({ email: "not-an-email" }).toSQL()
        expect.unreachable("expected ValidationError")
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError)
        const ve = err as ValidationError
        expect(ve.table).toBe("users")
        expect(ve.column).toBe("email")
        expect(ve.value).toBe("not-an-email")
        expect(ve.message).toBe("users.email: invalid email")
      }
    })

    it("validator returning `false` uses default 'invalid value' message", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              name: (v) => typeof v === "string" && v.length > 0,
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
          },
        },
      })
      try {
        db.insertInto("users").values({ name: "" }).toSQL()
        expect.unreachable("expected ValidationError")
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError)
        expect((err as ValidationError).message).toBe("users.name: invalid value")
      }
    })

    it("multiple validators run in declaration order; first failure wins", () => {
      const calls: string[] = []
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: [
                (v) => {
                  calls.push("first")
                  return typeof v === "string" || "not a string"
                },
                (v) => {
                  calls.push("second")
                  return (
                    (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) ||
                    "invalid email"
                  )
                },
                (v) => {
                  calls.push("third")
                  return (typeof v === "string" && v.length <= 255) || "email too long"
                },
              ],
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      // The first validator should pass (it's a string), the second
      // should fail (not an email), and the third should NOT run.
      try {
        db.insertInto("users").values({ email: "nope" }).toSQL()
        expect.unreachable("expected ValidationError")
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError)
        expect((err as ValidationError).message).toBe("users.email: invalid email")
        expect(calls).toEqual(["first", "second"])
      }
    })

    it("multiple validators all pass for a valid value", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: [
                (v) => typeof v === "string" || "not a string",
                (v) =>
                  (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) ||
                  "invalid email",
                (v) => (typeof v === "string" && v.length <= 255) || "email too long",
              ],
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      const q = db.insertInto("users").values({ email: "ok@host.com" }).toSQL()
      expect(q.params).toContain("ok@host.com")
    })

    it("non-configured columns are pass-through (unconfigured columns)", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: (v) => typeof v === "string" || "must be string",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
            name: text().notNull(),
          },
        },
      })
      // `name` has no validator, so anything goes (even though we
      // wouldn't pass an integer in real code — we just check that
      // the plugin doesn't fire on unconfigured columns).
      const q = db
        .insertInto("users")
        .values({ email: "ok@host.com", name: "anything goes" })
        .toSQL()
      expect(q.params).toContain("anything goes")
    })

    it("non-configured tables are pass-through", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: () => "always fails",
            },
          }),
        ],
        tables: {
          users: { id: serial().primaryKey(), email: text().notNull() },
          posts: { id: serial().primaryKey(), title: text().notNull() },
        },
      })
      // `posts` isn't in the config — `users` validators never fire.
      const q = db.insertInto("posts").values({ title: "Hello" }).toSQL()
      expect(q.params).toContain("Hello")
    })

    it("number column validators (age range)", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              age: (v) => (typeof v === "number" && v >= 0 && v <= 150) || "age out of range",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            age: integer().notNull(),
          },
        },
      })
      // Valid age.
      const ok = db.insertInto("users").values({ age: 42 }).toSQL()
      expect(ok.params).toContain(42)

      // Out of range.
      expect(() => db.insertInto("users").values({ age: 200 }).toSQL()).toThrow(/age out of range/)
      expect(() => db.insertInto("users").values({ age: -1 }).toSQL()).toThrow(/age out of range/)
    })

    it("bulk INSERT (valuesMany) — first failing row throws", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              age: (v) => (typeof v === "number" && v >= 0) || "age must be non-negative",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            age: integer().notNull(),
          },
        },
      })
      // All valid → passes.
      const ok = db
        .insertInto("users")
        .valuesMany([{ age: 10 }, { age: 20 }])
        .toSQL()
      expect(ok.params).toEqual([10, 20])

      // Second row invalid → throws.
      expect(() =>
        db
          .insertInto("users")
          .valuesMany([{ age: 10 }, { age: -5 }])
          .toSQL(),
      ).toThrow(/age must be non-negative/)
    })

    it("empty validator array passes through", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: [],
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      // No validators → never fails.
      const q = db.insertInto("users").values({ email: "anything" }).toSQL()
      expect(q.params).toContain("anything")
    })

    it("empty config is a no-op", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [validators({})],
        tables: {
          users: { id: serial().primaryKey(), email: text().notNull() },
        },
      })
      const q = db.insertInto("users").values({ email: "X@X" }).toSQL()
      expect(q.params).toContain("X@X")
    })
  })

  describe("UPDATE", () => {
    it("validates SET values", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: (v) =>
                (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || "invalid email",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      // Valid → passes.
      const ok = db
        .update("users")
        .set({ email: "new@host.com" })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(ok.params).toContain("new@host.com")

      // Invalid → throws.
      expect(() =>
        db
          .update("users")
          .set({ email: "still-bad" })
          .where(({ id }) => id.eq(1))
          .toSQL(),
      ).toThrow(/invalid email/)
    })

    it("unconfigured column in SET is pass-through", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: { email: () => "rejects everything" },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
            name: text().notNull(),
          },
        },
      })
      // `name` isn't configured → no validation.
      const q = db
        .update("users")
        .set({ name: "Renamed" })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.params).toContain("Renamed")
    })

    it("non-ParamNode SET value passes through (typed function expression)", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              // Would reject *any* literal — but we never get a
              // literal here. The Expression goes through unwrap and
              // lands as a FunctionCallNode, not a ParamNode, so the
              // plugin can't statically inspect it and bails.
              updated_at: () => "must be a literal",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            updated_at: timestamptz().notNull(),
          },
        },
      })
      const q = db
        .update("users")
        .set({ updated_at: now() })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).toContain("NOW()")
    })
  })

  describe("SELECT / DELETE pass-through", () => {
    it("SELECT WHERE is not validated", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              email: () => "rejects everything",
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      // We're not *writing* an email — we're querying *for* one. The
      // plugin is strictly for write-side input validation; rewriting
      // SELECT/DELETE WHERE values would surprise callers.
      const q = db
        .selectFrom("users")
        .select("id")
        .where(({ email }) => email.eq("anything"))
        .toSQL()
      expect(q.params).toContain("anything")
    })

    it("DELETE WHERE is not validated", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: { email: () => "rejects everything" },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            email: text().notNull(),
          },
        },
      })
      const q = db
        .deleteFrom("users")
        .where(({ email }) => email.eq("anything"))
        .toSQL()
      expect(q.params).toContain("anything")
    })
  })

  describe("null-handling", () => {
    it("validator sees `null` and decides", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              nick: (v) => (v === null ? "nick cannot be null" : true),
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            nick: text().nullable(),
          },
        },
      })
      expect(() => db.insertInto("users").values({ nick: null }).toSQL()).toThrow(
        /nick cannot be null/,
      )
    })

    it("validator can opt-out on null with early return", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          validators({
            users: {
              nick: (v) => {
                if (v === null) return true
                return (typeof v === "string" && v.length >= 3) || "nick too short"
              },
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            nick: text().nullable(),
          },
        },
      })
      // null is opted-out → passes.
      const ok = db.insertInto("users").values({ nick: null }).toSQL()
      expect(ok.params).toContain(null)

      // short string → fails.
      expect(() => db.insertInto("users").values({ nick: "ab" }).toSQL()).toThrow(/nick too short/)
    })
  })

  describe("PGlite roundtrip", () => {
    it("rejects invalid input before the query reaches the DB", async () => {
      const pg = new PGlite()
      try {
        await pg.exec(`
          DROP TABLE IF EXISTS val_users CASCADE;
          CREATE TABLE val_users (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL,
            age INT
          );
        `)
        const db = sumak({
          dialect: pgDialect(),
          driver: pgliteDriver(pg),
          plugins: [
            validators({
              val_users: {
                email: (v) =>
                  (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) ||
                  "invalid email",
                age: (v) => (typeof v === "number" && v >= 0 && v <= 150) || "age out of range",
              },
            }),
          ],
          tables: {
            val_users: {
              id: serial().primaryKey(),
              email: text().notNull(),
              age: integer().nullable(),
            },
          },
        })

        // Valid → reaches DB, comes back.
        const ok = await db
          .insertInto("val_users")
          .values({ email: "alice@example.com", age: 30 })
          .returningAll()
          .one()
        expect(ok.email).toBe("alice@example.com")
        expect(ok.age).toBe(30)

        // Invalid → rejected *before* DB. We verify by counting rows
        // before / after the throw.
        const before = await db.selectFrom("val_users").select("id").many()
        expect(before).toHaveLength(1)

        await expect(
          db
            .insertInto("val_users")
            .values({ email: "not-an-email", age: 25 })
            .returningAll()
            .one(),
        ).rejects.toThrow(ValidationError)

        const after = await db.selectFrom("val_users").select("id").many()
        // No new row got persisted — the throw fired before SQL was sent.
        expect(after).toHaveLength(1)
      } finally {
        await pg.close()
      }
    })
  })
})
