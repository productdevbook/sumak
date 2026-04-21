import { describe, expect, it } from "vitest"

import { col, eq, lit } from "../src/ast/expression.ts"
import { SelectBuilder } from "../src/builder/select.ts"
import { sql } from "../src/builder/sql.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { optimize } from "../src/optimize/optimizer.ts"
import { MultiTenantPlugin } from "../src/plugin/multi-tenant.ts"
import { PgPrinter } from "../src/printer/pg.ts"
import { enumType, integer, serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #13 regressions", () => {
  describe("nested sql`` template sentinel renumbering", () => {
    it("inner sentinels do not collide with outer", () => {
      const inner = sql`inner=${"INNER_VAL"}`
      const outer = sql`SELECT ${"OUTER_VAL"}, (${inner}) FROM t`
      const node = (outer as any).node as { sql: string; params: unknown[] }
      expect(node.params).toEqual(["OUTER_VAL", "INNER_VAL"])
      // Each sentinel index should appear exactly once.
      expect(node.sql).toContain("SUMAK_PARAM_0")
      expect(node.sql).toContain("SUMAK_PARAM_1")
      // sanity: two distinct sentinels, not two _0
      expect(node.sql.match(/SUMAK_PARAM_0/g)).toHaveLength(1)
      expect(node.sql.match(/SUMAK_PARAM_1/g)).toHaveLength(1)
    })

    it("doubly nested templates keep params in order", () => {
      const a = sql`a=${"A"}`
      const b = sql`b=${"B"},${a}`
      const c = sql`${"C"},${b}`
      const node = (c as any).node as { params: unknown[]; sql: string }
      expect(node.params).toEqual(["C", "B", "A"])
      expect(node.sql.match(/SUMAK_PARAM_0/g)).toHaveLength(1)
      expect(node.sql.match(/SUMAK_PARAM_1/g)).toHaveLength(1)
      expect(node.sql.match(/SUMAK_PARAM_2/g)).toHaveLength(1)
    })
  })

  describe("MultiTenantPlugin traverses CTEs and subqueries", () => {
    const plugin = new MultiTenantPlugin({ tables: ["users"], tenantId: 42 })
    const db = sumak({
      dialect: pgDialect(),
      plugins: [plugin],
      tables: {
        users: { id: serial().primaryKey(), name: text(), tenant_id: integer() },
        posts: { id: serial().primaryKey(), user_id: integer(), tenant_id: integer() },
      },
    })

    it("filters tenant_id inside a CTE over a target table", () => {
      const cte = new SelectBuilder().columns("id", "name").from("users").build()
      const r = db.selectFrom("posts").with("active_users", cte).select("id").toSQL()
      // CTE body must filter tenant_id; without this the outer query
      // was shielded but the CTE leaked every tenant's rows.
      expect(r.sql).toMatch(
        /WITH "active_users" AS \(SELECT "id", "name" FROM "users" WHERE \("tenant_id" = \$1\)\)/,
      )
      expect(r.params).toContain(42)
    })

    it("filter is applied exactly once — not re-injected on re-walk", () => {
      const cte = new SelectBuilder().columns("id").from("users").build()
      const r = db.selectFrom("posts").with("u", cte).select("id").toSQL()
      // Exactly one `tenant_id = $N` predicate inside the CTE. Without
      // the MultiTenantApplied idempotency flag the walker re-applied
      // the plugin on recursion and emitted `tenant_id=$1 AND tenant_id=$2`.
      const matches = r.sql.match(/"tenant_id" = \$\d+/g) ?? []
      expect(matches).toHaveLength(1)
    })
  })

  describe("predicate pushdown is safe for OUTER joins", () => {
    it("LEFT JOIN predicate stays in WHERE (not pushed into ON)", () => {
      const q = new SelectBuilder()
        .columns("*")
        .from("a")
        .leftJoin("b", eq(col("id", "a"), col("a_id", "b")))
        .where(eq(col("active", "b"), lit(true)))
        .build()
      const optimized = optimize(q)
      const r = new PgPrinter().print(optimized)
      // Filter must remain in WHERE: otherwise NULL-extended unmatched
      // rows (allowed by LEFT JOIN) survive, changing the row count.
      expect(r.sql).toContain("WHERE")
      expect(r.sql).toContain('"b"."active" = TRUE')
      // The ON clause must NOT have been extended with `AND (b.active = TRUE)`.
      expect(r.sql).not.toMatch(/ON \(.*AND.*"b"\."active".*\)/)
    })

    it("INNER JOIN predicate is still pushed (safe rewrite)", () => {
      const q = new SelectBuilder()
        .columns("*")
        .from("a")
        .innerJoin("b", eq(col("id", "a"), col("a_id", "b")))
        .where(eq(col("active", "b"), lit(true)))
        .build()
      const optimized = optimize(q)
      const r = new PgPrinter().print(optimized)
      // INNER JOIN WHERE and ON are equivalent — pushdown is still safe.
      expect(r.sql).toContain('AND ("b"."active" = TRUE)')
      expect(r.sql).not.toContain("WHERE")
    })
  })

  describe("enumType escapes single quotes in values", () => {
    it("embedded single quote is doubled", () => {
      const et = enumType("a", "b'c" as any)
      expect((et as any)._def.dataType).toBe("enum('a','b''c')")
    })

    it("quote-breakout payload stays inside the string literal", () => {
      const payload = "x'); DROP TABLE users; --"
      const et = enumType("ok", payload as any)
      // After escaping the payload is a literal — no unquoted `);` left.
      expect((et as any)._def.dataType).toBe(`enum('ok','x''); DROP TABLE users; --')`)
    })
  })
})
