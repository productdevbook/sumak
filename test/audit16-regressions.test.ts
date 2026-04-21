import { describe, expect, it } from "vitest"

import { SelectBuilder } from "../src/builder/select.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { DDLPrinter } from "../src/printer/ddl.ts"
import { PgPrinter } from "../src/printer/pg.ts"

describe("Audit #16 regressions", () => {
  describe("DDL printExpr handles binary_op, unary, between, in, is_null", () => {
    it("CHECK with binary_op does NOT emit `(?)`", () => {
      const node = {
        type: "create_table" as const,
        table: { type: "table_ref" as const, name: "accounts" },
        columns: [
          {
            type: "column_definition" as const,
            name: "age",
            dataType: "INT",
            check: {
              type: "binary_op" as const,
              op: ">",
              left: { type: "column_ref" as const, column: "age" },
              right: { type: "literal" as const, value: 0 },
            },
          },
        ],
        constraints: [],
      }
      const r = new DDLPrinter("pg").print(node)
      expect(r.sql).toContain('CHECK (("age" > 0))')
      expect(r.sql).not.toContain("(?)")
    })

    it("CHECK with is_null works", () => {
      const node = {
        type: "create_table" as const,
        table: { type: "table_ref" as const, name: "t" },
        columns: [
          {
            type: "column_definition" as const,
            name: "email",
            dataType: "TEXT",
            check: {
              type: "is_null" as const,
              expr: { type: "column_ref" as const, column: "email" },
              negated: true,
            },
          },
        ],
        constraints: [],
      }
      const r = new DDLPrinter("pg").print(node)
      expect(r.sql).toContain("CHECK")
      expect(r.sql).toContain("IS NOT NULL")
    })

    it("unsupported expression type throws a helpful error", () => {
      const node = {
        type: "create_table" as const,
        table: { type: "table_ref" as const, name: "t" },
        columns: [
          {
            type: "column_definition" as const,
            name: "x",
            dataType: "INT",
            check: {
              type: "case" as const,
              whens: [],
              else_: undefined,
            },
          },
        ],
        constraints: [],
      }
      expect(() => new DDLPrinter("pg").print(node)).toThrow(/DDLPrinter does not support/)
    })
  })

  describe("DDL printExpr validates function_call name", () => {
    it("rejects function name with parens / semicolons", () => {
      const node = {
        type: "create_table" as const,
        table: { type: "table_ref" as const, name: "t" },
        columns: [
          {
            type: "column_definition" as const,
            name: "x",
            dataType: "INT",
            defaultTo: {
              type: "function_call" as const,
              name: "foo(); DROP TABLE users; --",
              args: [],
            },
          },
        ],
        constraints: [],
      }
      expect(() => new DDLPrinter("pg").print(node)).toThrow(/Unsafe SQL function name/)
    })

    it("accepts legitimate function names (NOW, upper, etc.)", () => {
      const node = {
        type: "create_table" as const,
        table: { type: "table_ref" as const, name: "t" },
        columns: [
          {
            type: "column_definition" as const,
            name: "x",
            dataType: "INT",
            defaultTo: {
              type: "function_call" as const,
              name: "COALESCE",
              args: [{ type: "literal" as const, value: 0 }],
            },
          },
        ],
        constraints: [],
      }
      const r = new DDLPrinter("pg").print(node)
      expect(r.sql).toContain("DEFAULT COALESCE(0)")
    })
  })

  describe("UNION inner SELECT with pagination is parenthesized", () => {
    it("inner SELECT with orderBy + limit gets parens", () => {
      const inner = new SelectBuilder()
        .columns("*")
        .from("posts")
        .orderBy({ type: "column_ref", column: "id" }, "ASC")
        .limit({ type: "literal", value: 5 })
        .build()
      const q = new SelectBuilder()
        .columns("*")
        .from("posts")
        .union(inner)
        .orderBy({ type: "column_ref", column: "id" }, "DESC")
        .limit({ type: "literal", value: 10 })
        .build()
      const r = new PgPrinter().print(q)
      // Inner must be wrapped in parens; outer ORDER BY / LIMIT at end.
      expect(r.sql).toMatch(
        /UNION \(SELECT .* ORDER BY "id" ASC LIMIT 5\) ORDER BY "id" DESC LIMIT 10/,
      )
    })

    it("inner SELECT without pagination stays unwrapped", () => {
      const inner = new SelectBuilder().columns("*").from("posts").build()
      const q = new SelectBuilder()
        .columns("*")
        .from("posts")
        .union(inner)
        .orderBy({ type: "column_ref", column: "id" }, "DESC")
        .build()
      const r = new PgPrinter().print(q)
      expect(r.sql).toContain("UNION SELECT")
      expect(r.sql).not.toContain("UNION (")
    })
  })

  describe("MSSQL rejects CREATE … IF NOT EXISTS", () => {
    const node = {
      type: "create_table" as const,
      table: { type: "table_ref" as const, name: "users" },
      columns: [{ type: "column_definition" as const, name: "id", dataType: "INT" }],
      constraints: [],
      ifNotExists: true,
    }

    it("CREATE TABLE IF NOT EXISTS throws on MSSQL", () => {
      expect(() => new DDLPrinter("mssql").print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("CREATE TABLE IF NOT EXISTS works on PG", () => {
      const r = new DDLPrinter("pg").print(node)
      expect(r.sql).toContain("IF NOT EXISTS")
    })

    it("CREATE INDEX IF NOT EXISTS throws on MSSQL", () => {
      const idx = {
        type: "create_index" as const,
        name: "idx_users_id",
        table: "users",
        columns: [{ column: "id" }],
        ifNotExists: true,
      }
      expect(() => new DDLPrinter("mssql").print(idx)).toThrow(UnsupportedDialectFeatureError)
    })
  })
})
