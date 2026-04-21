import { describe, expect, it } from "vitest"

import { mssqlDialect } from "../src/dialect/mssql.ts"
import { mysqlDialect } from "../src/dialect/mysql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { serial, text, integer } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #11 regressions", () => {
  describe("MySQL UPDATE RETURNING throws", () => {
    it("throws UnsupportedDialectFeatureError", () => {
      const db = sumak({
        dialect: mysqlDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() =>
        db
          .update("users")
          .set({ name: "Bob" })
          .where(({ id }) => id.eq(1))
          .returning("id")
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("PG UPDATE RETURNING still works", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      const r = db
        .update("users")
        .set({ name: "Bob" })
        .where(({ id }) => id.eq(1))
        .returning("id")
        .toSQL()
      expect(r.sql).toContain("RETURNING")
    })
  })

  describe("distinctFrom dialect rewrites", () => {
    it("MySQL: distinctFrom → NOT (a <=> b)", () => {
      const db = sumak({
        dialect: mysqlDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      const r = db
        .selectFrom("users")
        .where(({ age }) => age.distinctFrom(null))
        .select("id")
        .toSQL()
      expect(r.sql).toContain("<=>")
      expect(r.sql).toContain("NOT")
      expect(r.sql).not.toContain("IS DISTINCT FROM")
    })

    it("MySQL: distinctFrom(negate) → a <=> b", () => {
      const db = sumak({
        dialect: mysqlDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      const r = db
        .selectFrom("users")
        .where(({ age }) => age.distinctFrom(null, { negate: true }))
        .select("id")
        .toSQL()
      expect(r.sql).toContain("<=>")
      expect(r.sql).not.toContain("IS NOT DISTINCT FROM")
    })

    it("SQLite: distinctFrom → IS NOT / IS (native null-safe)", () => {
      const db = sumak({
        dialect: sqliteDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      const r = db
        .selectFrom("users")
        .where(({ age }) => age.distinctFrom(null))
        .select("id")
        .toSQL()
      expect(r.sql).toContain("IS NOT")
      expect(r.sql).not.toContain("DISTINCT FROM")
    })

    it("MSSQL: distinctFrom throws (no pre-2022 equivalent)", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      expect(() =>
        db
          .selectFrom("users")
          .where(({ age }) => age.distinctFrom(null))
          .select("id")
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("PG: distinctFrom keeps native IS [NOT] DISTINCT FROM", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      const r = db
        .selectFrom("users")
        .where(({ age }) => age.distinctFrom(null))
        .select("id")
        .toSQL()
      expect(r.sql).toContain("IS DISTINCT FROM")
    })
  })

  describe("ILIKE dialect guards", () => {
    it("MySQL: ILIKE throws (LIKE is case-insensitive by default)", () => {
      const db = sumak({
        dialect: mysqlDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() =>
        db
          .selectFrom("users")
          .where(({ name }) => name.like("%alice%", { insensitive: true }))
          .select("id")
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite: ILIKE throws (LIKE is ASCII case-insensitive by default)", () => {
      const db = sumak({
        dialect: sqliteDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() =>
        db
          .selectFrom("users")
          .where(({ name }) => name.like("%alice%", { insensitive: true }))
          .select("id")
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("MSSQL: ILIKE throws (suggests COLLATE)", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() =>
        db
          .selectFrom("users")
          .where(({ name }) => name.like("%alice%", { insensitive: true }))
          .select("id")
          .toSQL(),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("PG: ILIKE works natively", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      const r = db
        .selectFrom("users")
        .where(({ name }) => name.like("%alice%", { insensitive: true }))
        .select("id")
        .toSQL()
      expect(r.sql).toContain("ILIKE")
    })
  })
})
