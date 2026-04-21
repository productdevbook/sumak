import { describe, expect, it } from "vitest"

import type { FunctionCallNode, SelectNode } from "../src/ast/nodes.ts"
import { createSelectNode, tableRef } from "../src/ast/nodes.ts"
import { rowNumber } from "../src/builder/eb.ts"
import { mssqlDialect } from "../src/dialect/mssql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { integer, serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #10 regressions", () => {
  describe("INSERT values() row-shape mismatch throws", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull(), age: integer() },
      },
    })

    it("two rows with different columns throws, preventing VALUES mismatch", () => {
      expect(() =>
        db
          .insertInto("users")
          .values({ name: "A", age: 10 })
          .values({ name: "B" } as any),
      ).toThrow(/row shape must match/)
    })

    it("two rows with different key order also throws", () => {
      expect(() =>
        db
          .insertInto("users")
          .values({ name: "A", age: 10 })
          .values({ age: 20, name: "B" } as any),
      ).toThrow(/row shape must match/)
    })

    it("two rows with same keys in same order — OK", () => {
      const q = db
        .insertInto("users")
        .values({ name: "A", age: 10 })
        .values({ name: "B", age: 20 })
        .toSQL()
      expect(q.sql).toContain("VALUES")
      expect(q.params).toEqual(["A", 10, "B", 20])
    })
  })

  describe("Window-only functions throw when emitted without OVER", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey() } },
    })

    it("bare `rowNumber()` in SELECT throws at print time", () => {
      expect(() =>
        db
          .selectFrom("users")
          .select({ rn: rowNumber() as any })
          .toSQL(),
      ).toThrow(/window function/)
    })

    it("`over(rowNumber(), w => w.orderBy(...))` is allowed", async () => {
      const { over } = await import("../src/builder/eb.ts")
      const r = db
        .selectFrom("users")
        .select({ rn: over(rowNumber(), (w) => w.orderBy("id")) })
        .toSQL()
      expect(r.sql).toContain("ROW_NUMBER() OVER")
    })

    it("raw AST with window-only name also throws at print time", () => {
      const printer = new PgPrinter()
      const fn: FunctionCallNode = { type: "function_call", name: "LAG", args: [] }
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("t"),
        columns: [fn],
      }
      expect(() => printer.print(node)).toThrow(/window function/)
    })
  })

  describe("CREATE VIEW dialect guards", () => {
    it("PG accepts OR REPLACE + asSelect", async () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      const sel = db.selectFrom("users").select("id").build()
      const r = db.compileDDL(db.schema.createView("v").orReplace().asSelect(sel).build())
      expect(r.sql).toContain("CREATE OR REPLACE VIEW")
    })

    it("MSSQL rejects OR REPLACE (has no equivalent — use ALTER VIEW)", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const sel = db.selectFrom("users").select("id").build()
      expect(() =>
        db.compileDDL(db.schema.createView("v").orReplace().asSelect(sel).build()),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite rejects OR REPLACE (suggests DROP+CREATE)", () => {
      const db = sumak({
        dialect: sqliteDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const sel = db.selectFrom("users").select("id").build()
      expect(() =>
        db.compileDDL(db.schema.createView("v").orReplace().asSelect(sel).build()),
      ).toThrow(UnsupportedDialectFeatureError)
    })

    it("OR REPLACE + IF NOT EXISTS together throws (mutually exclusive)", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey() } },
      })
      const sel = db.selectFrom("users").select("id").build()
      expect(() =>
        db.compileDDL(db.schema.createView("v").orReplace().ifNotExists().asSelect(sel).build()),
      ).toThrow(/mutually exclusive/)
    })
  })
})
