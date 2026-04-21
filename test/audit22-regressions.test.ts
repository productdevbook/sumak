import { describe, expect, it } from "vitest"

import { col, eq } from "../src/ast/expression.ts"
import { DeleteBuilder } from "../src/builder/delete.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { DDLPrinter } from "../src/printer/ddl.ts"
import { PgPrinter } from "../src/printer/pg.ts"

describe("Audit #22 regressions", () => {
  describe("Multi-action ALTER TABLE emits one comma-joined statement on pg/mysql", () => {
    const node = {
      type: "alter_table" as const,
      table: { type: "table_ref" as const, name: "users" },
      actions: [
        {
          kind: "add_column" as const,
          column: { type: "column_definition" as const, name: "a", dataType: "INTEGER" },
        },
        {
          kind: "add_column" as const,
          column: { type: "column_definition" as const, name: "b", dataType: "INTEGER" },
        },
      ],
    }

    it("PG: single ALTER TABLE with comma-joined actions (atomic)", () => {
      const r = new DDLPrinter("pg").print(node)
      expect(r.sql).toBe('ALTER TABLE "users" ADD COLUMN "a" INTEGER, ADD COLUMN "b" INTEGER')
      // No "; " glue between statements.
      expect((r.sql.match(/ALTER TABLE/g) ?? []).length).toBe(1)
    })

    it("MySQL: same comma form", () => {
      const r = new DDLPrinter("mysql").print(node)
      expect(r.sql).toBe("ALTER TABLE `users` ADD COLUMN `a` INTEGER, ADD COLUMN `b` INTEGER")
      expect((r.sql.match(/ALTER TABLE/g) ?? []).length).toBe(1)
    })

    it("SQLite: still splits into separate statements (no multi-action support)", () => {
      const r = new DDLPrinter("sqlite").print(node)
      expect((r.sql.match(/ALTER TABLE/g) ?? []).length).toBe(2)
      expect(r.sql).toContain("; ")
    })
  })

  describe("MSSQL uses sp_rename for rename_column / rename_table", () => {
    it("rename_column → EXEC sp_rename 'tbl.from', 'to', 'COLUMN'", () => {
      const node = {
        type: "alter_table" as const,
        table: { type: "table_ref" as const, name: "users" },
        actions: [{ kind: "rename_column" as const, from: "email", to: "email_addr" }],
      }
      const r = new DDLPrinter("mssql").print(node)
      expect(r.sql).toContain("EXEC sp_rename N'users.email', N'email_addr', N'COLUMN'")
      expect(r.sql).not.toContain("RENAME COLUMN")
    })

    it("rename_table → EXEC sp_rename 'tbl', 'new'", () => {
      const node = {
        type: "alter_table" as const,
        table: { type: "table_ref" as const, name: "users" },
        actions: [{ kind: "rename_table" as const, to: "members" }],
      }
      const r = new DDLPrinter("mssql").print(node)
      expect(r.sql).toContain("EXEC sp_rename N'users', N'members'")
      expect(r.sql).not.toContain("RENAME TO")
    })

    it("PG/MySQL/SQLite still emit ALTER TABLE ... RENAME (native)", () => {
      const node = {
        type: "alter_table" as const,
        table: { type: "table_ref" as const, name: "users" },
        actions: [{ kind: "rename_column" as const, from: "a", to: "b" }],
      }
      for (const d of ["pg", "mysql", "sqlite"] as const) {
        const r = new DDLPrinter(d).print(node)
        expect(r.sql).toContain("RENAME COLUMN")
      }
    })

    it("single-quote in table/column names is escaped inside sp_rename", () => {
      const node = {
        type: "alter_table" as const,
        table: { type: "table_ref" as const, name: "users" },
        actions: [{ kind: "rename_column" as const, from: "a'b", to: "c'd" }],
      }
      const r = new DDLPrinter("mssql").print(node)
      // Doubled single quotes inside the sp_rename string literals.
      expect(r.sql).toContain("N'users.a''b'")
      expect(r.sql).toContain("N'c''d'")
    })
  })

  describe("PG DELETE with JOIN is rejected (pointer at .using)", () => {
    it("rejects innerJoin on DELETE for pg dialect", () => {
      const node = new DeleteBuilder()
        .from("orders")
        .innerJoin("customers", eq(col("customer_id", "orders"), col("id", "customers")))
        .build()
      expect(() => new PgPrinter().print(node)).toThrow(UnsupportedDialectFeatureError)
    })

    it("DELETE ... USING still works on pg", () => {
      const node = new DeleteBuilder()
        .from("orders")
        .using("customers")
        .where(eq(col("customer_id", "orders"), col("id", "customers")))
        .build()
      const r = new PgPrinter().print(node)
      expect(r.sql).toContain("USING")
    })
  })
})
