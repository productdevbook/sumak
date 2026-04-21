import { describe, expect, it } from "vitest"

import { createDeleteNode, createMergeNode, createUpdateNode } from "../src/ast/nodes.ts"
import type { DeleteNode, MergeNode, SubqueryNode, UpdateNode } from "../src/ast/nodes.ts"
import { case_ } from "../src/builder/eb.ts"
import { mssqlDialect } from "../src/dialect/mssql.ts"
import { UnsupportedDialectFeatureError } from "../src/errors.ts"
import { MssqlPrinter } from "../src/printer/mssql.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #14 regressions", () => {
  describe("MSSQL UPDATE/DELETE with LIMIT/ORDER BY is rejected", () => {
    it("UPDATE with limit throws UnsupportedDialectFeatureError", () => {
      const upd: UpdateNode = {
        ...createUpdateNode({ type: "table_ref", name: "t" }),
        set: [{ column: "c", value: { type: "literal", value: 1 } }],
        limit: { type: "literal", value: 10 },
      }
      expect(() => new MssqlPrinter().print(upd)).toThrow(UnsupportedDialectFeatureError)
    })

    it("DELETE with orderBy throws UnsupportedDialectFeatureError", () => {
      const del: DeleteNode = {
        ...createDeleteNode({ type: "table_ref", name: "t" }),
        orderBy: [
          {
            expr: { type: "column_ref", column: "id" },
            direction: "ASC",
          },
        ],
      }
      expect(() => new MssqlPrinter().print(del)).toThrow(UnsupportedDialectFeatureError)
    })

    it("UPDATE without limit/orderBy still works", () => {
      const upd: UpdateNode = {
        ...createUpdateNode({ type: "table_ref", name: "t" }),
        set: [{ column: "c", value: { type: "literal", value: 1 } }],
      }
      const r = new MssqlPrinter().print(upd)
      expect(r.sql).toBe("UPDATE [t] SET [c] = 1")
    })
  })

  describe("MERGE subquery source no longer emits double alias", () => {
    it("alias on subquery is dropped; sourceAlias wins", async () => {
      const { createSelectNode } = await import("../src/ast/nodes.ts")
      const sub: SubqueryNode = {
        type: "subquery",
        query: {
          ...createSelectNode(),
          columns: [{ type: "star" }],
          from: { type: "table_ref", name: "users" },
        },
        alias: "s",
      }
      const merge: MergeNode = createMergeNode({ type: "table_ref", name: "users" }, sub, "s", {
        type: "literal",
        value: true,
      })
      merge.whens.push({
        type: "matched",
        action: "update",
        set: [{ column: "name", value: { type: "literal", value: "x" } }],
      })
      const r = new PgPrinter().print(merge)
      // Exactly one `AS "s"`, not `AS "s" AS "s"`.
      expect(r.sql.match(/AS "s"/g)).toHaveLength(1)
    })
  })

  describe("CASE with no WHEN is rejected at builder time", () => {
    it("case_().end() throws with a helpful message", () => {
      expect(() => case_().end()).toThrow(/requires at least one \.when/)
    })

    it("case_().else_(x).end() also throws (ELSE alone is still invalid)", () => {
      expect(() =>
        case_()
          .else_({ node: { type: "literal", value: 1 } } as any)
          .end(),
      ).toThrow(/requires at least one \.when/)
    })
  })

  describe("MSSQL literal .offset(0) does not force ORDER BY", () => {
    it(".offset(0) with no limit emits no OFFSET clause and no ORDER BY error", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { t: { id: serial().primaryKey(), name: text() } },
      })
      const r = db.selectFrom("t").select("id").offset(0).toSQL()
      expect(r.sql).toBe("SELECT [id] FROM [t]")
    })

    it(".offset(5) without orderBy still throws", () => {
      const db = sumak({
        dialect: mssqlDialect(),
        tables: { t: { id: serial().primaryKey(), name: text() } },
      })
      expect(() => db.selectFrom("t").select("id").offset(5).toSQL()).toThrow(
        UnsupportedDialectFeatureError,
      )
    })
  })

  describe("PluginManager walks MERGE subquery source", () => {
    it("MultiTenant plugin filters a subquery MERGE source", async () => {
      const { MultiTenantPlugin } = await import("../src/plugin/multi-tenant.ts")
      const { createSelectNode } = await import("../src/ast/nodes.ts")
      const plugin = new MultiTenantPlugin({ tables: ["users"], tenantId: 42 })
      const { PluginManager } = await import("../src/plugin/plugin-manager.ts")
      const pm = new PluginManager([plugin])

      const subSelect = {
        ...createSelectNode(),
        from: { type: "table_ref" as const, name: "users" },
        columns: [{ type: "star" as const }],
      }
      const merge: MergeNode = createMergeNode(
        { type: "table_ref", name: "users" },
        { type: "subquery", query: subSelect },
        "s",
        { type: "literal", value: true },
      )
      merge.whens.push({
        type: "matched",
        action: "update",
        set: [{ column: "name", value: { type: "literal", value: "x" } }],
      })

      const out = pm.transformNode(merge) as MergeNode
      expect(out.source.type).toBe("subquery")
      if (out.source.type !== "subquery") throw new Error("unreachable")
      // Inner subquery SELECT must carry the tenant predicate.
      expect(out.source.query.where).toBeDefined()
    })
  })
})
