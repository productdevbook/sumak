import { describe, expect, it } from "vitest"

import { col, eq, lit } from "../src/ast/expression.ts"
import { SelectBuilder } from "../src/builder/select.ts"
import { mssqlDialect } from "../src/dialect/mssql.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { normalizeExpression } from "../src/normalize/expression.ts"
import { AuditTimestampPlugin } from "../src/plugin/audit-timestamp.ts"
import { MssqlPrinter } from "../src/printer/mssql.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { serial, text, timestamptz } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"
import { parseTableRef } from "../src/utils/table-ref.ts"

describe("Audit #15 regressions", () => {
  describe("MSSQL boolean literal emits 1/0", () => {
    it("literal true in WHERE emits 1", () => {
      const r = new MssqlPrinter().print({
        type: "select",
        columns: [{ type: "star" }],
        from: { type: "table_ref", name: "t" },
        joins: [],
        ctes: [],
        groupBy: [],
        orderBy: [],
        distinct: false,
        where: {
          type: "binary_op",
          op: "=",
          left: { type: "column_ref", column: "active" },
          right: { type: "literal", value: true },
        },
      })
      expect(r.sql).toContain("= 1")
      expect(r.sql).not.toContain("TRUE")
    })

    it("literal false emits 0", () => {
      const r = new MssqlPrinter().print({
        type: "select",
        columns: [{ type: "star" }],
        from: { type: "table_ref", name: "t" },
        joins: [],
        ctes: [],
        groupBy: [],
        orderBy: [],
        distinct: false,
        where: { type: "literal", value: false },
      })
      expect(r.sql).toContain("WHERE 0")
    })

    it("PG still emits TRUE/FALSE (other dialects unchanged)", () => {
      const q = new SelectBuilder()
        .columns("*")
        .from("t")
        .where(eq(col("active"), lit(true)))
        .build()
      const r = new PgPrinter().print(q)
      expect(r.sql).toContain("TRUE")
    })
  })

  describe("AuditTimestampPlugin emits CURRENT_TIMESTAMP (portable)", () => {
    it("MSSQL INSERT uses CURRENT_TIMESTAMP, not NOW()", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        plugins: [new AuditTimestampPlugin({ tables: ["users"] })],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text(),
            created_at: timestamptz().nullable(),
            updated_at: timestamptz().nullable(),
          },
        },
      })
      const r = db
        .insertInto("users")
        .values({ name: "Ada" } as any)
        .toSQL()
      expect(r.sql).toContain("CURRENT_TIMESTAMP")
      expect(r.sql).not.toContain("NOW()")
    })

    it("SQLite UPDATE uses CURRENT_TIMESTAMP", () => {
      const db = sumak({
        dialect: sqliteDialect(),
        plugins: [new AuditTimestampPlugin({ tables: ["users"] })],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text(),
            updated_at: timestamptz().nullable(),
          },
        },
      })
      const r = db
        .update("users")
        .set({ name: "Bob" })
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(r.sql).toContain("CURRENT_TIMESTAMP")
      expect(r.sql).not.toContain("NOW()")
    })
  })

  describe("parseTableRef rejects quoted identifiers", () => {
    it("double-quoted identifier throws", () => {
      expect(() => parseTableRef('"my.table"')).toThrow(/quoted identifiers are not supported/)
    })

    it("backtick-quoted identifier throws", () => {
      expect(() => parseTableRef("`my.table`")).toThrow(/quoted identifiers are not supported/)
    })

    it("bracket-quoted identifier throws", () => {
      expect(() => parseTableRef("[my.table]")).toThrow(/quoted identifiers are not supported/)
    })

    it("plain schema.table still works", () => {
      expect(parseTableRef("audit.logs")).toEqual({
        type: "table_ref",
        name: "logs",
        schema: "audit",
        alias: undefined,
      })
    })
  })

  describe("constant folding preserves SQL integer division semantics", () => {
    it("5 / 2 is NOT folded (integer division in SQL = 2, JS = 2.5)", () => {
      const expr = {
        type: "binary_op" as const,
        op: "/",
        left: { type: "literal" as const, value: 5 },
        right: { type: "literal" as const, value: 2 },
      }
      const folded = normalizeExpression(expr)
      // Binary op must remain intact, not collapse to literal 2.5.
      expect(folded.type).toBe("binary_op")
    })

    it("5 % 2 is NOT folded when both operands are integers", () => {
      const expr = {
        type: "binary_op" as const,
        op: "%",
        left: { type: "literal" as const, value: 5 },
        right: { type: "literal" as const, value: 2 },
      }
      const folded = normalizeExpression(expr)
      expect(folded.type).toBe("binary_op")
    })

    it("5.0 / 2.0 IS folded (float operands — SQL does float division too)", () => {
      const expr = {
        type: "binary_op" as const,
        op: "/",
        left: { type: "literal" as const, value: 5.5 },
        right: { type: "literal" as const, value: 2 },
      }
      const folded = normalizeExpression(expr)
      // 5.5 is not an integer, so folding is safe.
      expect(folded.type).toBe("literal")
    })

    it("5 + 2 (addition) still folds — semantics are identical in JS and SQL", () => {
      const expr = {
        type: "binary_op" as const,
        op: "+",
        left: { type: "literal" as const, value: 5 },
        right: { type: "literal" as const, value: 2 },
      }
      const folded = normalizeExpression(expr)
      expect(folded).toEqual({ type: "literal", value: 7 })
    })
  })
})
