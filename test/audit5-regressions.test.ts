import { describe, expect, it } from "vitest"

import { col, eq, param, star } from "../src/ast/expression.ts"
import type { DeleteNode, FunctionCallNode, InsertNode, SelectNode } from "../src/ast/nodes.ts"
import { createDeleteNode, createInsertNode, createSelectNode, tableRef } from "../src/ast/nodes.ts"
import { over, rowNumber } from "../src/builder/eb.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { MssqlPrinter } from "../src/printer/mssql.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #5 regressions", () => {
  describe("MSSQL OUTPUT clause handles qualified star", () => {
    const printer = new MssqlPrinter()

    it("INSERT … OUTPUT INSERTED.* for bare star", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "users" }),
        columns: ["name"],
        values: [[param(0, "Alice")]],
        returning: [star()],
      }
      const r = printer.print(node)
      expect(r.sql).toContain("OUTPUT INSERTED.*")
      expect(r.sql).not.toContain('INSERTED."')
    })

    it("INSERT … OUTPUT INSERTED.[users].* for table-qualified star", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "users" }),
        columns: ["name"],
        values: [[param(0, "Alice")]],
        returning: [{ type: "star", table: "users" }],
      }
      const r = printer.print(node)
      // Previously emitted `INSERTED."users".*` (wrong quote style + bug)
      expect(r.sql).toContain("OUTPUT INSERTED.[users].*")
    })

    it("DELETE … OUTPUT DELETED.[t].* for table-qualified star", () => {
      const node: DeleteNode = {
        ...createDeleteNode({ type: "table_ref", name: "users" }),
        returning: [{ type: "star", table: "users" }],
        where: eq(col("id"), param(0, 1)),
      }
      const r = printer.print(node)
      expect(r.sql).toContain("OUTPUT DELETED.[users].*")
    })

    it("INSERT OUTPUT with non-star column nodes still prefixes correctly", () => {
      const node: InsertNode = {
        ...createInsertNode({ type: "table_ref", name: "users" }),
        columns: ["name"],
        values: [[param(0, "Alice")]],
        returning: [col("id"), col("name")],
      }
      const r = printer.print(node)
      expect(r.sql).toContain("INSERTED.[id]")
      expect(r.sql).toContain("INSERTED.[name]")
    })
  })

  describe("MySQL GROUPS window frame rejection", () => {
    it("mysql throws UnsupportedDialectFeatureError on GROUPS frame", () => {
      const printer = new MysqlPrinter()
      const expr = over(rowNumber(), (w) => w.orderBy("id").groups({ type: "unbounded_preceding" }))
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("t"),
        columns: [(expr as any).node],
      }
      expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("pg allows GROUPS frame (PG 11+ supports it)", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { t: { id: serial().primaryKey() } },
      })
      const r = db
        .selectFrom("t")
        .select({
          rn: over(rowNumber(), (w) => w.orderBy("id").groups({ type: "unbounded_preceding" })),
        })
        .toSQL()
      expect(r.sql).toContain("GROUPS UNBOUNDED PRECEDING")
    })
  })

  describe("SELECT … UNION: ORDER BY / LIMIT / OFFSET emitted after the set-op", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })

    it("UNION with outer ORDER BY places ORDER BY after the second SELECT", () => {
      const q1 = db.selectFrom("users").select("id")
      const q2 = db.selectFrom("users").select("id")
      const r = q1.orderBy("id").union(q2).toSQL()
      const orderIdx = r.sql.indexOf("ORDER BY")
      const unionIdx = r.sql.indexOf("UNION")
      expect(unionIdx).toBeGreaterThan(-1)
      expect(orderIdx).toBeGreaterThan(-1)
      expect(orderIdx).toBeGreaterThan(unionIdx) // ORDER BY AFTER UNION
    })

    it("UNION without outer ORDER BY — no trailing ORDER BY emitted", () => {
      const q1 = db.selectFrom("users").select("id")
      const q2 = db.selectFrom("users").select("id")
      const r = q1.union(q2).toSQL()
      expect(r.sql).not.toContain("ORDER BY")
    })

    it("three-way UNION chain emits two UNIONs, no orphan ORDER BY", () => {
      const q1 = db.selectFrom("users").select("id")
      const q2 = db.selectFrom("users").select("id")
      const q3 = db.selectFrom("users").select("id")
      const r = q1.union(q2).union(q3).toSQL()
      const unions = (r.sql.match(/UNION/g) ?? []).length
      expect(unions).toBe(2)
    })

    it("UNION + outer LIMIT emits LIMIT after the second SELECT", () => {
      const q1 = db.selectFrom("users").select("id")
      const q2 = db.selectFrom("users").select("id")
      const r = q1.limit(10).union(q2).toSQL()
      const limitIdx = r.sql.indexOf("LIMIT")
      const unionIdx = r.sql.indexOf("UNION")
      expect(limitIdx).toBeGreaterThan(unionIdx)
    })
  })

  describe("printFunctionCall case policy", () => {
    it("standard SQL fn names uppercase (portable for MSSQL / case-sensitive MySQL)", () => {
      const printer = new PgPrinter()
      const fn: FunctionCallNode = { type: "function_call", name: "row_number", args: [] }
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("t"),
        columns: [fn],
      }
      const r = printer.print(node)
      expect(r.sql).toContain("ROW_NUMBER(")
      expect(r.sql).not.toContain("row_number(")
    })

    it("user-defined fn names pass through verbatim (preserves mixed-case UDFs)", () => {
      const printer = new PgPrinter()
      const fn: FunctionCallNode = { type: "function_call", name: "my_custom_udf", args: [] }
      const node: SelectNode = {
        ...createSelectNode(),
        from: tableRef("t"),
        columns: [fn],
      }
      const r = printer.print(node)
      expect(r.sql).toContain("my_custom_udf(")
      expect(r.sql).not.toContain("MY_CUSTOM_UDF(")
    })
  })

  describe("CREATE INDEX USING rejects non-identifier strings", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), tags: text().notNull() } },
    })

    it("accepts bare identifier (btree, gin, gist)", () => {
      const node = db.schema.createIndex("idx").on("users").column("tags").using("gin").build()
      const r = db.compileDDL(node)
      expect(r.sql).toContain("USING gin")
    })

    it("rejects attacker-controlled strings with extra statements", () => {
      const node = db.schema
        .createIndex("idx")
        .on("users")
        .column("tags")
        .using("btree; DROP TABLE users--")
        .build()
      expect(() => db.compileDDL(node)).toThrow()
    })
  })
})
