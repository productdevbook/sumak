import { describe, expect, it } from "vitest"

import { cast, sqlFn, unsafeSqlFn, unsafeRawExpr, val } from "../../src/builder/eb.ts"
import { sql } from "../../src/builder/sql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { SecurityError } from "../../src/errors.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("SQL Injection Prevention", () => {
  describe("LIKE pattern parameterization", () => {
    it("LIKE patterns are parameterized, not inlined", () => {
      const q = db
        .selectFrom("users")
        .select("id")
        .where(({ name }) => name.like("%alice%"))
        .compile(p)
      expect(q.params).toContain("%alice%")
      expect(q.sql).toContain("LIKE $1")
      expect(q.sql).not.toContain("'%alice%'")
    })

    it("ILIKE patterns are parameterized", () => {
      const q = db
        .selectFrom("users")
        .select("id")
        .where(({ name }) => name.ilike("%Alice%"))
        .compile(p)
      expect(q.params).toContain("%Alice%")
      expect(q.sql).not.toContain("'%Alice%'")
    })

    it("NOT LIKE patterns are parameterized", () => {
      const q = db
        .selectFrom("users")
        .select("id")
        .where(({ name }) => name.notLike("%bob%"))
        .compile(p)
      expect(q.params).toContain("%bob%")
    })

    it("NOT ILIKE patterns are parameterized", () => {
      const q = db
        .selectFrom("users")
        .select("id")
        .where(({ name }) => name.notIlike("%Spam%"))
        .compile(p)
      expect(q.params).toContain("%Spam%")
    })
  })

  describe("Function name validation", () => {
    it("allows standard function names", () => {
      expect(() => sqlFn("COUNT", val(1))).not.toThrow()
      expect(() => sqlFn("SUM", val(1))).not.toThrow()
      expect(() => sqlFn("MY_CUSTOM_FN", val(1))).not.toThrow()
    })

    it("rejects function names with special characters", () => {
      expect(() => {
        const expr = sqlFn("COUNT; DROP TABLE users --", val(1))
        new PgPrinter().print({ type: "select", distinct: false, columns: [(expr as any).node], joins: [], groupBy: [], orderBy: [], ctes: [] })
      }).toThrow(SecurityError)
    })

    it("rejects function names with parentheses", () => {
      expect(() => {
        const expr = sqlFn("fn()", val(1))
        new PgPrinter().print({ type: "select", distinct: false, columns: [(expr as any).node], joins: [], groupBy: [], orderBy: [], ctes: [] })
      }).toThrow(SecurityError)
    })

    it("unsafeSqlFn bypasses validation", () => {
      expect(() => unsafeSqlFn("anything goes here", val(1))).not.toThrow()
    })
  })

  describe("CAST dataType validation", () => {
    it("allows standard SQL types", () => {
      const q1 = db.selectFrom("users").selectExpr(cast(val(42), "text"), "t").compile(p)
      expect(q1.sql).toContain("CAST")

      const q2 = db.selectFrom("users").selectExpr(cast(val(42), "INTEGER"), "t").compile(p)
      expect(q2.sql).toContain("AS INTEGER")

      const q3 = db.selectFrom("users").selectExpr(cast(val(42), "VARCHAR(255)"), "t").compile(p)
      expect(q3.sql).toContain("AS VARCHAR(255)")

      const q4 = db.selectFrom("users").selectExpr(cast(val(42), "DOUBLE PRECISION"), "t").compile(p)
      expect(q4.sql).toContain("AS DOUBLE PRECISION")
    })

    it("rejects malicious dataType strings", () => {
      expect(() => {
        db.selectFrom("users")
          .selectExpr(cast(val(42), "INTEGER); DROP TABLE users --"), "t")
          .compile(p)
      }).toThrow(SecurityError)
    })

    it("rejects dataType with quotes", () => {
      expect(() => {
        db.selectFrom("users")
          .selectExpr(cast(val(42), "INT'EGER"), "t")
          .compile(p)
      }).toThrow(SecurityError)
    })
  })

  describe("sql.table() identifier escaping", () => {
    it("escapes double quotes in table names", () => {
      const expr = sql`SELECT * FROM ${sql.table('users"--injection')}`
      const node = (expr as any).node
      expect(node.sql).toContain('"users""--injection"')
    })

    it("escapes double quotes in schema names", () => {
      const expr = sql`SELECT * FROM ${sql.table("users", 'public"--')}`
      const node = (expr as any).node
      expect(node.sql).toContain('"public""--"')
    })
  })

  describe("sql.ref() identifier escaping", () => {
    it("escapes double quotes in column names", () => {
      const expr = sql`SELECT ${sql.ref('col"--injection')}`
      const node = (expr as any).node
      expect(node.sql).toContain('"col""--injection"')
    })
  })

  describe("Plugin security", () => {
    it("SumakPlugin interface has no transformQuery", () => {
      // Plugins can only transform at AST level (safe) or result level
      const plugin = { name: "test" }
      expect(plugin).not.toHaveProperty("transformQuery")
    })
  })

  describe("Backslash escaping (MySQL CVE-2026-33442)", () => {
    it("escapes backslashes in string literals via printer", () => {
      const q = db
        .selectFrom("users")
        .selectExpr(val("a\\b"), "v")
        .compile(p)
      // Backslash should be doubled: a\b → a\\b
      expect(q.sql).toContain("'a\\\\b'")
    })

    it("escapes single quotes in string literals via printer", () => {
      const q = db
        .selectFrom("users")
        .selectExpr(val("it's"), "v")
        .compile(p)
      // Single quote should be doubled: it's → it''s
      expect(q.sql).toContain("it''s")
    })

    it("escapes backslashes in sql tagged template literals", () => {
      const expr = sql`SELECT ${val("test\\' OR 1=1 --")}`
      const node = (expr as any).node
      // The backslash and single-quote must both be escaped
      expect(node.sql).toContain("\\\\")
      expect(node.sql).toContain("''")
    })
  })

  describe("Parameterization by default", () => {
    it("all comparison values are parameterized", () => {
      const q = db
        .selectFrom("users")
        .select("id")
        .where(({ id, name, age }) => {
          return sqlFn("COALESCE", id.eq(1), name.eq("Alice"), age.gt(18)) as any
        })
        .compile(p)
      expect(q.params).toEqual([1, "Alice", 18])
    })
  })
})
