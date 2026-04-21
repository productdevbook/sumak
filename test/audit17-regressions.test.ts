import { describe, expect, it } from "vitest"

import type { MergeNode, SelectNode } from "../src/ast/nodes.ts"
import { createMergeNode, createSelectNode } from "../src/ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { MultiTenantPlugin } from "../src/plugin/multi-tenant.ts"
import { PluginManager } from "../src/plugin/plugin-manager.ts"
import { DDLPrinter } from "../src/printer/ddl.ts"
import { MysqlPrinter } from "../src/printer/mysql.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { SqlitePrinter } from "../src/printer/sqlite.ts"

describe("Audit #17 regressions", () => {
  describe("Plugin walker descends into WHERE/HAVING subqueries", () => {
    const plugin = new MultiTenantPlugin({ tables: ["orders"], tenantId: 42 })
    const pm = new PluginManager([plugin])

    it("WHERE EXISTS (SELECT FROM target) filters the inner SELECT", () => {
      const innerOrders: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "orders" },
        columns: [{ type: "column_ref", column: "id" }],
      }
      const outer: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "products" },
        columns: [{ type: "star" }],
        where: { type: "exists", query: innerOrders, negated: false },
      }
      const transformed = pm.transformNode(outer) as SelectNode
      const r = new PgPrinter().print(transformed)
      // Inner orders SELECT must now carry tenant_id filter.
      expect(r.sql).toContain('FROM "orders" WHERE ("tenant_id" = $1)')
      expect(r.params).toContain(42)
    })

    it("WHERE col IN (SELECT FROM target) filters the inner SELECT", () => {
      const innerOrders: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "orders" },
        columns: [{ type: "column_ref", column: "id" }],
      }
      const outer: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "products" },
        columns: [{ type: "star" }],
        where: {
          type: "in",
          expr: { type: "column_ref", column: "id" },
          values: innerOrders,
          negated: false,
        },
      }
      const transformed = pm.transformNode(outer) as SelectNode
      const r = new PgPrinter().print(transformed)
      expect(r.sql).toContain('FROM "orders" WHERE ("tenant_id" = $1)')
    })

    it("WHERE col = (SELECT scalar FROM target) filters the inner SELECT", () => {
      const innerOrders: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "orders" },
        columns: [{ type: "column_ref", column: "id" }],
      }
      const outer: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "products" },
        columns: [{ type: "star" }],
        where: {
          type: "binary_op",
          op: "=",
          left: { type: "column_ref", column: "id" },
          right: { type: "subquery", query: innerOrders },
        },
      }
      const transformed = pm.transformNode(outer) as SelectNode
      const r = new PgPrinter().print(transformed)
      expect(r.sql).toContain('FROM "orders" WHERE ("tenant_id" = $1)')
    })
  })

  describe("MERGE is rejected on MySQL and SQLite", () => {
    const makeMerge = (): MergeNode => {
      const m = createMergeNode(
        { type: "table_ref", name: "t" },
        { type: "table_ref", name: "s" },
        "s",
        { type: "literal", value: true },
      )
      m.whens.push({
        type: "matched",
        action: "update",
        set: [{ column: "x", value: { type: "literal", value: 1 } }],
      })
      return m
    }

    it("MySQL MERGE throws", () => {
      expect(() => new MysqlPrinter().print(makeMerge())).toThrow(UnsupportedDialectFeatureError)
    })

    it("SQLite MERGE throws", () => {
      expect(() => new SqlitePrinter().print(makeMerge())).toThrow(UnsupportedDialectFeatureError)
    })
  })

  describe("autoIncrement emits dialect-correct keyword", () => {
    const node = {
      type: "create_table" as const,
      table: { type: "table_ref" as const, name: "users" },
      columns: [
        {
          type: "column_definition" as const,
          name: "id",
          dataType: "INTEGER",
          primaryKey: true,
          autoIncrement: true,
        },
      ],
      constraints: [],
    }

    it("PG rewrites INTEGER to SERIAL", () => {
      const r = new DDLPrinter("pg").print(node)
      expect(r.sql).toContain("SERIAL")
      expect(r.sql).not.toContain("INTEGER")
    })

    it("MSSQL emits IDENTITY(1,1)", () => {
      const r = new DDLPrinter("mssql").print(node)
      expect(r.sql).toContain("IDENTITY(1,1)")
    })

    it("SQLite emits AUTOINCREMENT when combined with PK", () => {
      const r = new DDLPrinter("sqlite").print(node)
      expect(r.sql).toContain("AUTOINCREMENT")
    })

    it("MySQL emits AUTO_INCREMENT (unchanged)", () => {
      const r = new DDLPrinter("mysql").print(node)
      expect(r.sql).toContain("AUTO_INCREMENT")
    })

    it("PG BIGINT becomes BIGSERIAL", () => {
      const bigNode = {
        ...node,
        columns: [
          {
            type: "column_definition" as const,
            name: "id",
            dataType: "BIGINT",
            primaryKey: true,
            autoIncrement: true,
          },
        ],
      }
      const r = new DDLPrinter("pg").print(bigNode)
      expect(r.sql).toContain("BIGSERIAL")
    })
  })
})
