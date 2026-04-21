import { describe, expect, it } from "vitest"

import { mssqlDialect } from "../src/dialect/mssql.ts"
import { mysqlDialect } from "../src/dialect/mysql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { SecurityError, UnsupportedDialectFeatureError } from "../src/errors.ts"
import { tx } from "../src/ns/tx.ts"
import { sumak } from "../src/sumak.ts"
import { validateDataType } from "../src/utils/security.ts"

describe("Audit #9 regressions", () => {
  describe("validateDataType — accepts compound precision+suffix types", () => {
    it("accepts TIMESTAMP(6) WITH TIME ZONE", () => {
      expect(() => validateDataType("TIMESTAMP(6) WITH TIME ZONE")).not.toThrow()
    })

    it("accepts TIME(3) WITH TIME ZONE", () => {
      expect(() => validateDataType("TIME(3) WITH TIME ZONE")).not.toThrow()
    })

    it("still accepts bare and array forms", () => {
      expect(() => validateDataType("INTEGER")).not.toThrow()
      expect(() => validateDataType("VARCHAR(255)")).not.toThrow()
      expect(() => validateDataType("NUMERIC(10, 2)")).not.toThrow()
      expect(() => validateDataType("TEXT[]")).not.toThrow()
      expect(() => validateDataType("TIMESTAMP WITH TIME ZONE")).not.toThrow()
      expect(() => validateDataType("DOUBLE PRECISION")).not.toThrow()
    })

    it("still blocks injection attempts", () => {
      expect(() => validateDataType("INTEGER); DROP TABLE t--")).toThrow(SecurityError)
      expect(() => validateDataType('TEXT"; --')).toThrow(SecurityError)
      expect(() => validateDataType("INT/* comment */")).toThrow(SecurityError)
    })
  })

  describe("BEGIN isolation guards", () => {
    it("PG emits ISOLATION LEVEL on BEGIN", () => {
      const db = sumak({ dialect: pgDialect(), tables: {} })
      const r = db.compile(tx.begin({ isolation: "SERIALIZABLE" }))
      expect(r.sql).toContain("ISOLATION LEVEL SERIALIZABLE")
    })

    it("SQLite rejects BEGIN ISOLATION (was silent drop)", () => {
      const db = sumak({ dialect: sqliteDialect(), tables: {} })
      expect(() => db.compile(tx.begin({ isolation: "SERIALIZABLE" }))).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("MSSQL rejects BEGIN ISOLATION with a pointer at setTransaction()", () => {
      const db = sumak({ dialect: mssqlDialect(), tables: {} })
      expect(() => db.compile(tx.begin({ isolation: "SNAPSHOT" }))).toThrow(/tx\.setTransaction/)
    })

    it("MySQL rejects BEGIN ISOLATION", () => {
      const db = sumak({ dialect: mysqlDialect(), tables: {} })
      expect(() => db.compile(tx.begin({ isolation: "SERIALIZABLE" }))).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("SQLite still accepts bare BEGIN", () => {
      const db = sumak({ dialect: sqliteDialect(), tables: {} })
      const r = db.compile(tx.begin())
      expect(r.sql).toBe("BEGIN")
    })
  })

  describe("COMMIT / ROLLBACK AND CHAIN dialect guards", () => {
    it("PG emits COMMIT AND CHAIN", () => {
      const db = sumak({ dialect: pgDialect(), tables: {} })
      const r = db.compile(tx.commit({ chain: true }))
      expect(r.sql).toBe("COMMIT AND CHAIN")
    })

    it("MSSQL throws on COMMIT AND CHAIN", () => {
      const db = sumak({ dialect: mssqlDialect(), tables: {} })
      expect(() => db.compile(tx.commit({ chain: true }))).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite throws on ROLLBACK AND CHAIN", () => {
      const db = sumak({ dialect: sqliteDialect(), tables: {} })
      expect(() => db.compile(tx.rollback({ chain: true }))).toThrow(UnsupportedDialectFeatureError)
    })
  })

  describe("setTransaction SNAPSHOT isolation", () => {
    it("MSSQL accepts SNAPSHOT isolation", () => {
      const db = sumak({ dialect: mssqlDialect(), tables: {} })
      const r = db.compile(tx.setTransaction({ isolation: "SNAPSHOT" }))
      expect(r.sql).toContain("SNAPSHOT")
    })

    it("PG rejects SNAPSHOT isolation (not a PG isolation level)", () => {
      const db = sumak({ dialect: pgDialect(), tables: {} })
      expect(() => db.compile(tx.setTransaction({ isolation: "SNAPSHOT" as any }))).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  })

  describe("DROP VIEW / DROP INDEX CASCADE guards", () => {
    it("PG accepts DROP VIEW ... CASCADE", () => {
      const db = sumak({ dialect: pgDialect(), tables: {} })
      const r = db.compileDDL(db.schema.dropView("v").cascade().build())
      expect(r.sql).toContain("CASCADE")
    })

    it("MySQL rejects DROP VIEW ... CASCADE", () => {
      const db = sumak({ dialect: mysqlDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.dropView("v").cascade().build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("MSSQL rejects DROP VIEW ... CASCADE", () => {
      const db = sumak({ dialect: mssqlDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.dropView("v").cascade().build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })

    it("MySQL rejects DROP INDEX ... CASCADE", () => {
      const db = sumak({ dialect: mysqlDialect(), tables: {} })
      expect(() => db.compileDDL(db.schema.dropIndex("idx").on("t").cascade().build())).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  })
})
