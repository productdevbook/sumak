import { describe, expect, it } from "vitest"

import type { MergeNode, SelectNode } from "../src/ast/nodes.ts"
import { createMergeNode, createSelectNode } from "../src/ast/nodes.ts"
import { SecurityError } from "../src/errors.ts"
import { normalizeExpression } from "../src/normalize/expression.ts"
import { MultiTenantPlugin } from "../src/plugin/multi-tenant.ts"
import { PluginManager } from "../src/plugin/plugin-manager.ts"
import { DDLPrinter } from "../src/printer/ddl.ts"
import { PgPrinter } from "../src/printer/pg.ts"

describe("Audit #20 regressions", () => {
  describe("Plugin walker descends into MERGE ON / WHEN clauses", () => {
    const plugin = new MultiTenantPlugin({ tables: ["users"], tenantId: 42 })
    const pm = new PluginManager([plugin])

    it("MERGE ON EXISTS(SELECT FROM tenant_table) filters the inner SELECT", () => {
      const innerUsers: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "users" },
        columns: [{ type: "literal", value: 1 }],
      }

      const merge: MergeNode = createMergeNode(
        { type: "table_ref", name: "users" },
        { type: "table_ref", name: "staging" },
        "s",
        {
          type: "binary_op",
          op: "AND",
          left: {
            type: "binary_op",
            op: "=",
            left: { type: "column_ref", table: "users", column: "id" },
            right: { type: "column_ref", table: "s", column: "id" },
          },
          right: { type: "exists", query: innerUsers, negated: false },
        },
      )
      merge.whens.push({
        type: "matched",
        action: "update",
        set: [{ column: "name", value: { type: "literal", value: "x" } }],
      })

      const transformed = pm.transformNode(merge) as MergeNode
      const r = new PgPrinter().print(transformed)
      // Inner SELECT on `users` must now carry the tenant filter.
      expect(r.sql).toContain('FROM "users" WHERE ("tenant_id" = $1)')
    })

    it("MERGE WHEN MATCHED AND EXISTS(SELECT FROM tenant_table) filters inner SELECT", () => {
      const innerUsers: SelectNode = {
        ...createSelectNode(),
        from: { type: "table_ref", name: "users" },
        columns: [{ type: "literal", value: 1 }],
      }
      const merge: MergeNode = createMergeNode(
        { type: "table_ref", name: "users" },
        { type: "table_ref", name: "staging" },
        "s",
        {
          type: "binary_op",
          op: "=",
          left: { type: "column_ref", table: "users", column: "id" },
          right: { type: "column_ref", table: "s", column: "id" },
        },
      )
      merge.whens.push({
        type: "matched",
        action: "update",
        condition: { type: "exists", query: innerUsers, negated: false },
        set: [{ column: "name", value: { type: "literal", value: "x" } }],
      })

      const transformed = pm.transformNode(merge) as MergeNode
      const r = new PgPrinter().print(transformed)
      // Inner SELECT body must carry its own tenant predicate —
      // separate from the outer MERGE ON clause's filter.
      expect(r.sql).toMatch(/EXISTS \(SELECT 1 FROM "users" WHERE \("tenant_id" = \$\d+\)\)/)
    })
  })

  describe("Constant folding does not fold || (dialect-divergent semantics)", () => {
    it("'a' || 'b' stays as a binary_op", () => {
      const folded = normalizeExpression({
        type: "binary_op",
        op: "||",
        left: { type: "literal", value: "a" },
        right: { type: "literal", value: "b" },
      })
      expect(folded.type).toBe("binary_op")
    })
  })

  describe("DDL validateDataType on column definition + ALTER set_data_type", () => {
    it("CREATE TABLE with injection payload in column type throws SecurityError", () => {
      const node = {
        type: "create_table" as const,
        table: { type: "table_ref" as const, name: "users" },
        columns: [
          {
            type: "column_definition" as const,
            name: "email",
            dataType: "VARCHAR(255); DROP TABLE audits --",
          },
        ],
        constraints: [],
      }
      expect(() => new DDLPrinter("pg").print(node)).toThrow(SecurityError)
    })

    it("ALTER TABLE SET DATA TYPE with injection payload throws", () => {
      const node = {
        type: "alter_table" as const,
        table: { type: "table_ref" as const, name: "users" },
        actions: [
          {
            kind: "alter_column" as const,
            column: "email",
            set: {
              type: "set_data_type" as const,
              dataType: "VARCHAR(255); DROP TABLE audits --",
            },
          },
        ],
      }
      expect(() => new DDLPrinter("pg").print(node)).toThrow(SecurityError)
    })

    it("uppercase ENUM('a','b') is also accepted (case-insensitive)", () => {
      const node = {
        type: "create_table" as const,
        table: { type: "table_ref" as const, name: "t" },
        columns: [
          {
            type: "column_definition" as const,
            name: "status",
            dataType: "ENUM('active','inactive')",
          },
        ],
        constraints: [],
      }
      expect(() => new DDLPrinter("pg").print(node)).not.toThrow()
    })

    it("legitimate enumType dataType is accepted (enum('a','b'))", () => {
      const node = {
        type: "create_table" as const,
        table: { type: "table_ref" as const, name: "t" },
        columns: [
          {
            type: "column_definition" as const,
            name: "status",
            dataType: "enum('a','b')",
          },
        ],
        constraints: [],
      }
      const r = new DDLPrinter("pg").print(node)
      expect(r.sql).toContain("enum('a','b')")
    })

    it("common types (INTEGER, VARCHAR(255), TIMESTAMP WITH TIME ZONE, INTEGER[]) stay accepted", () => {
      for (const t of [
        "INTEGER",
        "VARCHAR(255)",
        "TEXT",
        "TIMESTAMP WITH TIME ZONE",
        "INTEGER[]",
      ]) {
        const node = {
          type: "create_table" as const,
          table: { type: "table_ref" as const, name: "t" },
          columns: [{ type: "column_definition" as const, name: "c", dataType: t }],
          constraints: [],
        }
        expect(() => new DDLPrinter("pg").print(node)).not.toThrow()
      }
    })
  })
})
