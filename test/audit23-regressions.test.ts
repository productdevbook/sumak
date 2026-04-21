import { describe, expect, it } from "vitest"

import type { CreateTableNode, CreateViewNode } from "../src/ast/ddl-nodes.ts"
import { CreateTableBuilder } from "../src/builder/ddl/create-table.ts"
import { SelectBuilder } from "../src/builder/select.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { MultiTenantPlugin } from "../src/plugin/multi-tenant.ts"
import { SoftDeletePlugin } from "../src/plugin/soft-delete.ts"
import { integer, serial, text, timestamptz } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #23 regressions", () => {
  describe("DDL AS SELECT is plugin-walked (CREATE TABLE AS SELECT)", () => {
    it("MultiTenant plugin filters the inner SELECT on CTAS", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [new MultiTenantPlugin({ tables: ["orders"], tenantId: 42 })],
        tables: {
          orders: { id: serial().primaryKey(), tenant_id: integer() },
        },
      })
      const inner = new SelectBuilder().columns("*").from("orders").build()
      const ddl = new CreateTableBuilder("orders_cache").asSelect(inner).build()
      const r = db.compileDDL(ddl)
      expect(r.sql).toContain('WHERE ("tenant_id" = $1)')
      expect(r.params).toContain(42)
    })

    it("SoftDelete plugin filters the inner SELECT on CTAS", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [new SoftDeletePlugin({ tables: ["orders"] })],
        tables: {
          orders: {
            id: serial().primaryKey(),
            deleted_at: timestamptz().nullable(),
          },
        },
      })
      const inner = new SelectBuilder().columns("*").from("orders").build()
      const ddl = new CreateTableBuilder("orders_cache").asSelect(inner).build()
      const r = db.compileDDL(ddl)
      expect(r.sql).toContain('"deleted_at" IS NULL')
    })

    it("CREATE VIEW AS SELECT also walks through plugins", () => {
      const db = sumak({
        dialect: pgDialect(),
        plugins: [new MultiTenantPlugin({ tables: ["orders"], tenantId: 7 })],
        tables: {
          orders: { id: serial().primaryKey(), tenant_id: integer() },
        },
      })
      const inner = new SelectBuilder().columns("*").from("orders").build()
      const viewNode: CreateViewNode = {
        type: "create_view",
        name: "tenant_orders",
        asSelect: inner,
      }
      const r = db.compileDDL(viewNode)
      expect(r.sql).toContain('WHERE ("tenant_id" = $1)')
      expect(r.params).toContain(7)
    })

    it("CTAS without plugins still works (no-op pipeline)", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: {
          orders: { id: serial().primaryKey(), name: text() },
        },
      })
      const inner = new SelectBuilder().columns("*").from("orders").build()
      const ddl: CreateTableNode = new CreateTableBuilder("orders_cache").asSelect(inner).build()
      const r = db.compileDDL(ddl)
      expect(r.sql).toContain("CREATE TABLE")
      expect(r.sql).toContain("SELECT")
      expect(r.sql).toContain("orders")
    })
  })
})
