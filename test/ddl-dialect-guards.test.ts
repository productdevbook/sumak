import { describe, expect, it } from "vitest"

import { mssqlDialect } from "../src/dialect/mssql.ts"
import { mysqlDialect } from "../src/dialect/mysql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { integer, serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("DDL dialect guards", () => {
  describe("DROP TABLE ... CASCADE", () => {
    it("PG supports CASCADE", () => {
      const db = sumak({ dialect: pgDialect(), tables: {} })
      const r = db.compileDDL(db.schema.dropTable("t").cascade().build())
      expect(r.sql).toContain("CASCADE")
    })

    it("SQLite rejects CASCADE", () => {
      const db = sumak({ dialect: sqliteDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.dropTable("t").cascade().build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("MSSQL rejects CASCADE", () => {
      const db = sumak({ dialect: mssqlDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.dropTable("t").cascade().build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  })

  describe("TRUNCATE TABLE", () => {
    it("SQLite rejects TRUNCATE entirely (no TRUNCATE in SQLite)", () => {
      const db = sumak({ dialect: sqliteDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.truncateTable("t").build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("PG accepts TRUNCATE ... RESTART IDENTITY CASCADE", () => {
      const db = sumak({ dialect: pgDialect(), tables: {} })
      const r = db.compileDDL(db.schema.truncateTable("t").restartIdentity().cascade().build())
      expect(r.sql).toContain("RESTART IDENTITY")
      expect(r.sql).toContain("CASCADE")
    })

    it("MSSQL rejects RESTART IDENTITY (different mechanism — DBCC CHECKIDENT)", () => {
      const db = sumak({ dialect: mssqlDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.truncateTable("t").restartIdentity().build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("MSSQL rejects CASCADE on TRUNCATE", () => {
      const db = sumak({ dialect: mssqlDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.truncateTable("t").cascade().build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("MSSQL accepts bare TRUNCATE TABLE", () => {
      const db = sumak({ dialect: mssqlDialect(), tables: {} })
      const r = db.compileDDL(db.schema.truncateTable("t").build())
      expect(r.sql).toContain("TRUNCATE TABLE")
    })

    it("MySQL rejects RESTART IDENTITY / CASCADE (use ALTER TABLE AUTO_INCREMENT)", () => {
      const db = sumak({ dialect: mysqlDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.truncateTable("t").restartIdentity().build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  })

  describe("CREATE INDEX partial (WHERE)", () => {
    it("MySQL rejects partial indexes", () => {
      const db = sumak({
        dialect: mysqlDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      const node = db.schema
        .createIndex("idx_adults")
        .on("users")
        .column("age")
        .where({ type: "raw", sql: "age > 18", params: [] })
        .build()
      expect(() => db.compileDDL(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("PG accepts partial indexes", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), age: integer() } },
      })
      const node = db.schema
        .createIndex("idx_adults")
        .on("users")
        .column("age")
        .where({ type: "raw", sql: "age > 18", params: [] })
        .build()
      const r = db.compileDDL(node)
      expect(r.sql).toContain("WHERE")
    })

    it("SQLite accepts partial indexes (3.8+)", () => {
      const db = sumak({
        dialect: sqliteDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      const node = db.schema
        .createIndex("idx_named")
        .on("users")
        .column("name")
        .where({ type: "raw", sql: "name IS NOT NULL", params: [] })
        .build()
      const r = db.compileDDL(node)
      expect(r.sql).toContain("WHERE")
    })
  })
})
