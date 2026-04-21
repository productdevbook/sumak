import { describe, expect, it } from "vitest"

import { excluded } from "../src/builder/eb.ts"
import { mssqlDialect } from "../src/dialect/mssql.ts"
import { mysqlDialect } from "../src/dialect/mysql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #8 regressions", () => {
  describe('excluded() helper produces `EXCLUDED."col"`, not `"EXCLUDED.col"`', () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          email: text().notNull(),
          name: text().notNull(),
        },
      },
    })

    it("references the pseudo-table correctly in ON CONFLICT DO UPDATE", () => {
      const q = db
        .insertInto("users")
        .values({ email: "a@b.com", name: "Alice" })
        .onConflict({
          columns: ["email"],
          do: { update: [{ column: "name", value: excluded("name") }] },
        })
        .toSQL()
      // Correct form: "EXCLUDED"."name" (two quoted identifiers).
      // Bug form:     "EXCLUDED.name"    (one identifier with a literal dot).
      expect(q.sql).toContain('"EXCLUDED"."name"')
      expect(q.sql).not.toContain('"EXCLUDED.name"')
    })
  })

  describe("INSERT OR IGNORE / REPLACE is SQLite-only — non-SQLite dialects reject", () => {
    it("SQLite still emits `INSERT OR IGNORE`", () => {
      const db = sumak({
        dialect: sqliteDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      const q = db.insertInto("users").values({ name: "Alice" }).orIgnore().toSQL()
      expect(q.sql).toContain("INSERT OR IGNORE")
    })

    it("MySQL throws UnsupportedDialectFeatureError", () => {
      const db = sumak({
        dialect: mysqlDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() => db.insertInto("users").values({ name: "Alice" }).orIgnore().toSQL()).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("PG throws UnsupportedDialectFeatureError with a helpful message", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() => db.insertInto("users").values({ name: "Alice" }).orIgnore().toSQL()).toThrow(
        /onConflict/,
      )
    })

    it("MSSQL throws UnsupportedDialectFeatureError", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() => db.insertInto("users").values({ name: "Alice" }).orIgnore().toSQL()).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  })
})
