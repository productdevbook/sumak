import { PGlite } from "@electric-sql/pglite"
import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { defaults } from "../../src/plugin/defaults.ts"
import { integer, serial, text, uuid } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

describe("defaults plugin", () => {
  describe("INSERT — single row", () => {
    it("injects a configured column the user omitted", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            users: {
              tenant_id: () => 42,
              created_by: () => 7,
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().nullable(),
            created_by: integer().nullable(),
          },
        },
      })
      const q = db.insertInto("users").values({ name: "Alice" }).toSQL()
      expect(q.sql).toMatch(/"users"\s*\(\s*"name",\s*"tenant_id",\s*"created_by"\s*\)/)
      expect(q.params).toEqual(["Alice", 42, 7])
    })

    it("respects explicit values — thunk is not called for present columns", () => {
      let called = 0
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            users: {
              tenant_id: () => {
                called++
                return 99
              },
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().nullable(),
          },
        },
      })
      const q = db.insertInto("users").values({ name: "Bob", tenant_id: 5 }).toSQL()
      expect(q.params).toContain(5)
      expect(q.params).not.toContain(99)
      expect(called).toBe(0)
    })

    it("partial omission — present column kept, missing one injected", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            users: {
              tenant_id: () => 1,
              created_by: () => 2,
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().nullable(),
            created_by: integer().nullable(),
          },
        },
      })
      const q = db.insertInto("users").values({ name: "C", created_by: 999 }).toSQL()
      // tenant_id injected, created_by left at user's value.
      expect(q.params).toContain(1)
      expect(q.params).toContain(999)
      expect(q.params).not.toContain(2)
    })

    it("thunk returning null skips the column", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            users: {
              tenant_id: () => null,
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().nullable(),
          },
        },
      })
      const q = db.insertInto("users").values({ name: "X" }).toSQL()
      // tenant_id was skipped — DB-side default (or NULL) applies.
      expect(q.sql).not.toContain('"tenant_id"')
      expect(q.params).toEqual(["X"])
    })

    it("each thunk fires once per INSERT call (fresh value)", () => {
      const ids = [10, 20, 30]
      let i = 0
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            users: {
              external_id: () => ids[i++]!,
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            external_id: integer().nullable(),
          },
        },
      })
      const q1 = db.insertInto("users").values({ name: "a" }).toSQL()
      const q2 = db.insertInto("users").values({ name: "b" }).toSQL()
      expect(q1.params).toContain(10)
      expect(q2.params).toContain(20)
    })
  })

  describe("INSERT — multi-row (valuesMany)", () => {
    it("injects defaults into every row, fresh thunk call per row", () => {
      const seq = [100, 200, 300]
      let i = 0
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            t: {
              version: () => seq[i++]!,
            },
          }),
        ],
        tables: {
          t: {
            id: serial().primaryKey(),
            name: text().notNull(),
            version: integer().nullable(),
          },
        },
      })
      const q = db
        .insertInto("t")
        .valuesMany([{ name: "a" }, { name: "b" }, { name: "c" }])
        .toSQL()
      // Three rows, each got its own version.
      expect(q.params).toEqual(["a", 100, "b", 200, "c", 300])
      // SQL must list "version" once in the column list with three
      // matching slots across the VALUES rows.
      expect(q.sql).toMatch(/\(\s*"name",\s*"version"\s*\)/)
    })

    it("a row with explicit value is left alone (other rows still get the default)", () => {
      // Note: valuesMany enforces the same key shape per row, so the
      // way "explicit on one row, missing on another" surfaces is that
      // *all* rows must specify the column or none does. The realistic
      // case is "all rows specify" vs "no row specifies" — both
      // covered.
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            t: {
              tenant_id: () => 1,
            },
          }),
        ],
        tables: {
          t: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().nullable(),
          },
        },
      })
      const q = db
        .insertInto("t")
        .valuesMany([
          { name: "a", tenant_id: 100 },
          { name: "b", tenant_id: 200 },
        ])
        .toSQL()
      // Both explicit values preserved.
      expect(q.params).toContain(100)
      expect(q.params).toContain(200)
      expect(q.params).not.toContain(1)
    })

    it("mixed null/non-null thunk results across rows — column kept, nulls materialised", () => {
      let i = 0
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            t: {
              // Returns null for the first row, value for the second.
              maybe: () => (i++ === 0 ? null : 42),
            },
          }),
        ],
        tables: {
          t: {
            id: serial().primaryKey(),
            name: text().notNull(),
            maybe: integer().nullable(),
          },
        },
      })
      const q = db
        .insertInto("t")
        .valuesMany([{ name: "a" }, { name: "b" }])
        .toSQL()
      // "maybe" is in the column list because at least one row needs it.
      expect(q.sql).toMatch(/"maybe"/)
      // First row's slot is the literal null param; second row is 42.
      expect(q.params).toEqual(["a", null, "b", 42])
    })

    it("every row returns null — column dropped entirely", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            t: {
              opt: () => null,
            },
          }),
        ],
        tables: {
          t: {
            id: serial().primaryKey(),
            name: text().notNull(),
            opt: integer().nullable(),
          },
        },
      })
      const q = db
        .insertInto("t")
        .valuesMany([{ name: "a" }, { name: "b" }])
        .toSQL()
      expect(q.sql).not.toContain('"opt"')
      expect(q.params).toEqual(["a", "b"])
    })
  })

  describe("INSERT — pass-through", () => {
    it("unconfigured table is pass-through", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [defaults({ users: { tenant_id: () => 1 } })],
        tables: {
          users: { id: serial().primaryKey(), tenant_id: integer().nullable() },
          posts: { id: serial().primaryKey(), title: text().notNull() },
        },
      })
      const q = db.insertInto("posts").values({ title: "hi" }).toSQL()
      expect(q.params).toEqual(["hi"])
      expect(q.sql).not.toContain("tenant_id")
    })

    it("unconfigured column is pass-through (only configured ones inject)", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [defaults({ users: { tenant_id: () => 1 } })],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().nullable(),
            other: integer().nullable(),
          },
        },
      })
      const q = db.insertInto("users").values({ name: "A" }).toSQL()
      expect(q.sql).toContain('"tenant_id"')
      expect(q.sql).not.toContain('"other"')
    })

    it("empty config = no-op", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [defaults({})],
        tables: {
          users: { id: serial().primaryKey(), name: text().notNull() },
        },
      })
      const q = db.insertInto("users").values({ name: "ok" }).toSQL()
      expect(q.params).toEqual(["ok"])
    })

    it("table with empty column map = no-op", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [defaults({ users: {} })],
        tables: {
          users: { id: serial().primaryKey(), name: text().notNull() },
        },
      })
      const q = db.insertInto("users").values({ name: "ok" }).toSQL()
      expect(q.params).toEqual(["ok"])
    })
  })

  describe("non-INSERT statements pass through unchanged", () => {
    const make = () =>
      sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            users: {
              tenant_id: () => {
                throw new Error("defaults plugin must not fire on non-INSERT")
              },
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().nullable(),
          },
          staging: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().nullable(),
          },
        },
      })

    it("UPDATE is pass-through (no tenant_id auto-set)", () => {
      const db = make()
      const q = db
        .update("users")
        .set({ name: "renamed" })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).not.toContain("tenant_id")
      expect(q.params).toContain("renamed")
    })

    it("DELETE is pass-through", () => {
      const db = make()
      const q = db
        .deleteFrom("users")
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).not.toContain("tenant_id")
    })

    it("SELECT is pass-through", () => {
      const db = make()
      const q = db.selectFrom("users").select("id", "name").toSQL()
      expect(q.sql).not.toContain("tenant_id")
    })

    it("MERGE is pass-through", () => {
      const db = make()
      const q = db
        .mergeInto("users", {
          source: "staging",
          alias: "s",
          on: ({ target, source }) => target.id.eq(source.id),
        })
        .whenNotMatchedThenInsert({ name: "n" })
        .toSQL()
      // tenant_id was not injected into the WHEN NOT MATCHED insert tuple.
      expect(q.sql).not.toContain("tenant_id")
    })
  })

  describe("PGlite roundtrip", () => {
    it("INSERT with auto-injected default round-trips end-to-end", async () => {
      const pg = new PGlite()
      try {
        await pg.exec(`
          DROP TABLE IF EXISTS def_users CASCADE;
          CREATE TABLE def_users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            tenant_id INT,
            external_id TEXT
          );
        `)
        let tenant = 100
        const db = sumak({
          dialect: pgDialect(),
          driver: pgliteDriver(pg),
          plugins: [
            defaults({
              def_users: {
                tenant_id: () => tenant,
                external_id: () => `ext-${tenant}`,
              },
            }),
          ],
          tables: {
            def_users: {
              id: serial().primaryKey(),
              name: text().notNull(),
              tenant_id: integer().nullable(),
              external_id: text().nullable(),
            },
          },
        })
        const row = await db.insertInto("def_users").values({ name: "Alice" }).returningAll().one()
        expect(row.name).toBe("Alice")
        expect(row.tenant_id).toBe(100)
        expect(row.external_id).toBe("ext-100")

        tenant = 200
        const row2 = await db
          .insertInto("def_users")
          .values({ name: "Bob", tenant_id: 999 })
          .returningAll()
          .one()
        // Explicit tenant_id preserved; external_id still injected.
        expect(row2.tenant_id).toBe(999)
        expect(row2.external_id).toBe("ext-200")
      } finally {
        await pg.close()
      }
    })

    it("multi-row INSERT with mixed null thunk results round-trips", async () => {
      const pg = new PGlite()
      try {
        await pg.exec(`
          DROP TABLE IF EXISTS def_multi CASCADE;
          CREATE TABLE def_multi (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            opt INT
          );
        `)
        let i = 0
        const db = sumak({
          dialect: pgDialect(),
          driver: pgliteDriver(pg),
          plugins: [
            defaults({
              def_multi: {
                opt: () => (i++ === 0 ? null : 7),
              },
            }),
          ],
          tables: {
            def_multi: {
              id: serial().primaryKey(),
              name: text().notNull(),
              opt: integer().nullable(),
            },
          },
        })
        const rows = await db
          .insertInto("def_multi")
          .valuesMany([{ name: "a" }, { name: "b" }])
          .returningAll()
          .many()
        const byName = new Map(rows.map((r) => [r.name, r.opt]))
        expect(byName.get("a")).toBeNull()
        expect(byName.get("b")).toBe(7)
      } finally {
        await pg.close()
      }
    })
  })

  describe("realistic usage", () => {
    it("generated uuid default", () => {
      const ids = ["00000000-0000-0000-0000-000000000001"]
      let i = 0
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            things: {
              uuid: () => ids[i++],
            },
          }),
        ],
        tables: {
          things: {
            id: serial().primaryKey(),
            label: text().notNull(),
            uuid: uuid().nullable(),
          },
        },
      })
      const q = db.insertInto("things").values({ label: "alpha" }).toSQL()
      expect(q.params).toContain("00000000-0000-0000-0000-000000000001")
    })

    it("tenantId + createdBy combo from request context closures", () => {
      const ctx = { tenantId: "T-1", userId: "U-42" }
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          defaults({
            users: {
              tenantId: () => ctx.tenantId,
              createdBy: () => ctx.userId,
            },
            posts: {
              tenantId: () => ctx.tenantId,
              authorId: () => ctx.userId,
            },
          }),
        ],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenantId: text().nullable(),
            createdBy: text().nullable(),
          },
          posts: {
            id: serial().primaryKey(),
            title: text().notNull(),
            tenantId: text().nullable(),
            authorId: text().nullable(),
          },
        },
      })
      const u = db.insertInto("users").values({ name: "Alice" }).toSQL()
      expect(u.params).toEqual(["Alice", "T-1", "U-42"])

      const p = db.insertInto("posts").values({ title: "Hello" }).toSQL()
      expect(p.params).toEqual(["Hello", "T-1", "U-42"])
    })
  })
})
