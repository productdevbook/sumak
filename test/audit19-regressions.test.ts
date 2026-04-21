import { describe, expect, it } from "vitest"

import { col, eq } from "../src/ast/expression.ts"
import { DeleteBuilder } from "../src/builder/delete.ts"
import { InsertBuilder } from "../src/builder/insert.ts"
import { mysqlDialect } from "../src/dialect/mysql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sqliteDialect } from "../src/dialect/sqlite.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { OptimisticLockPlugin } from "../src/plugin/optimistic-lock.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { SqlitePrinter } from "../src/printer/sqlite.ts"
import { integer, serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #19 regressions", () => {
  describe("INSERT column / value dimension check", () => {
    it("throws when columns.length != values[i].length", () => {
      const node = new InsertBuilder()
        .into("t")
        .columns("a", "b", "c")
        .values({ type: "literal", value: 1 }, { type: "literal", value: 2 })
        .build()
      expect(() => new PgPrinter().print(node)).toThrow(/column \/ value count mismatch/)
    })

    it("accepts matching dimensions", () => {
      const node = new InsertBuilder()
        .into("t")
        .columns("a", "b")
        .values({ type: "literal", value: 1 }, { type: "literal", value: 2 })
        .build()
      const r = new PgPrinter().print(node)
      // Values may be parameterized or inlined depending on the
      // builder path — just assert it runs without throwing.
      expect(r.sql).toContain('INSERT INTO "t"')
    })
  })

  describe("OptimisticLockPlugin seeds version on INSERT", () => {
    it("appends version column with initial value", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [new OptimisticLockPlugin({ tables: ["orders"], column: "version" })],
        tables: {
          orders: { id: serial().primaryKey(), total: integer(), version: integer() },
        },
      })
      const r = db
        .insertInto("orders")
        .values({ id: 1, total: 10 } as any)
        .toSQL()
      expect(r.sql).toContain('"version"')
      // Default initialVersion is 1 and is emitted as a literal (not a param).
      expect(r.sql).toContain(", 1)")
    })

    it("does not double-apply when caller already provides version", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [new OptimisticLockPlugin({ tables: ["orders"], column: "version" })],
        tables: {
          orders: { id: serial().primaryKey(), version: integer() },
        },
      })
      const r = db
        .insertInto("orders")
        .values({ id: 1, version: 7 } as any)
        .toSQL()
      // Caller-provided version wins — no duplicate column.
      expect((r.sql.match(/"version"/g) ?? []).length).toBe(1)
    })

    it("respects custom initialVersion", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [
          new OptimisticLockPlugin({ tables: ["orders"], column: "version", initialVersion: 42 }),
        ],
        tables: { orders: { id: serial().primaryKey(), version: integer() } },
      })
      const r = db
        .insertInto("orders")
        .values({ id: 1 } as any)
        .toSQL()
      expect(r.sql).toContain("42")
    })
  })

  describe("MySQL DELETE with JOIN emits correct multi-table form", () => {
    it("`DELETE t FROM t INNER JOIN u …` (not DELETE FROM t INNER JOIN)", () => {
      const node = new DeleteBuilder()
        .from("orders")
        .innerJoin("users", eq(col("id", "users"), col("user_id", "orders")))
        .build()
      const r = new MysqlPrinter().print(node)
      expect(r.sql).toMatch(/^DELETE `orders` FROM `orders` INNER JOIN/)
    })

    it("DELETE ... USING is rejected on MySQL", () => {
      const node = new DeleteBuilder().from("orders").using("users").build()
      expect(() => new MysqlPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("aliased target: DELETE o FROM orders AS o INNER JOIN …", () => {
      const node = new DeleteBuilder()
        .from({ type: "table_ref", name: "orders", alias: "o" })
        .innerJoin("users", eq(col("id", "users"), col("user_id", "o")))
        .build()
      const r = new MysqlPrinter().print(node)
      // Target identifier in DELETE must match the alias, not the bare name.
      expect(r.sql).toMatch(/^DELETE `o` FROM `orders` AS `o` INNER JOIN/)
    })

    it("SQLite multi-table DELETE (USING or JOIN) is rejected", () => {
      const node1 = new DeleteBuilder().from("orders").using("users").build()
      expect(() => new SqlitePrinter().print(node1)).toThrow(UnsupportedDialectFeatureError)
      const node2 = new DeleteBuilder()
        .from("orders")
        .innerJoin("users", eq(col("id", "users"), col("user_id", "orders")))
        .build()
      expect(() => new SqlitePrinter().print(node2)).toThrow(UnsupportedDialectFeatureError)
    })
  })
})
