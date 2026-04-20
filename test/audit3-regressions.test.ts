import { describe, expect, it } from "vitest"

import { jsonCol } from "../src/builder/json-optics.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { MultiTenantPlugin } from "../src/plugin/multi-tenant.ts"
import { integer, jsonb, serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("Audit #3 regressions", () => {
  describe("valuesMany empty input", () => {
    it("throws with a helpful message on empty rows array", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() => db.insertInto("users").valuesMany([])).toThrow(/at least one row/)
    })

    it("throws on .values({}) with an empty object", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      })
      expect(() => db.insertInto("users").values({} as any)).toThrow(/at least one column/)
    })
  })

  describe("MERGE WHEN MATCHED UPDATE with empty set", () => {
    it("throws instead of emitting `UPDATE SET ` with no columns", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: {
          users: { id: serial().primaryKey(), name: text().notNull() },
          staging: { id: serial().primaryKey(), name: text().notNull() },
        },
      })
      const m = db.mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      expect(() => m.whenMatchedThenUpdate({})).toThrow(/at least one column/)
    })
  })

  describe("InsertBuilder.defaultValues() clears conflicting state", () => {
    it(".values(...).defaultValues() emits DEFAULT VALUES without the values row", async () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: { users: { id: serial().primaryKey(), name: text().nullable() } },
      })
      const { InsertBuilder } = await import("../src/builder/insert.ts")
      const node = new InsertBuilder().into("users").columns("name").defaultValues().build()
      expect(node.columns).toEqual([])
      expect(node.values).toEqual([])
      expect(node.defaultValues).toBe(true)
      const r = db.compile(node)
      expect(r.sql).toContain("DEFAULT VALUES")
      expect(r.sql).not.toContain('"name"')
    })
  })

  describe("JSON atPath / textPath emits PG {a,b,c} array literal", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: { t: { id: serial().primaryKey(), data: jsonb() } },
    })

    it("#> path uses `'{a,b,c}'` form, not `'a.b.c'`", () => {
      const expr = jsonCol("data").atPath("address.city").toExpression()
      const q = db.selectFrom("t").select({ v: expr }).toSQL()
      expect(q.sql).toContain("#>'{address,city}'")
      expect(q.sql).not.toContain("'address.city'")
    })

    it("#>> text-path uses `'{a,b,c}'` form", () => {
      const expr = jsonCol("data").textPath("a.b").toExpression() as any
      const q = db.selectFrom("t").select({ v: expr }).toSQL()
      expect(q.sql).toContain("#>>'{a,b}'")
    })

    it("rejects segments with injection-prone characters", () => {
      const expr = jsonCol("data").atPath("a,b").toExpression()
      expect(() => db.selectFrom("t").select({ v: expr }).toSQL()).toThrow(
        /Invalid JSON path segment/,
      )
    })

    it("rejects empty segments (leading/trailing dot)", () => {
      const expr = jsonCol("data").atPath("a..b").toExpression()
      expect(() => db.selectFrom("t").select({ v: expr }).toSQL()).toThrow(
        /Invalid JSON path segment/,
      )
    })
  })

  describe("MultiTenant MERGE idempotency flag", () => {
    it("registering the plugin twice does not duplicate the tenant guard", () => {
      const plugin = new MultiTenantPlugin({ tables: ["users"], tenantId: 42 })
      const db = sumak({
        dialect: pgDialect(),
        plugins: [plugin, new MultiTenantPlugin({ tables: ["users"], tenantId: 42 })],
        tables: {
          users: {
            id: serial().primaryKey(),
            name: text().notNull(),
            tenant_id: integer().defaultTo(0),
          },
          staging: { id: serial().primaryKey(), name: text().notNull() },
        },
      })
      const q = db
        .mergeInto("users", {
          source: "staging",
          alias: "s",
          on: ({ target, source }) => target.id.eq(source.id),
        })
        .whenMatchedThenUpdate({ name: "x" })
        .toSQL()
      // tenant_id appears only in the ON target guard (one occurrence).
      const matches = q.sql.match(/"tenant_id"/g) ?? []
      expect(matches.length).toBe(1)
    })
  })

  describe("DDL CREATE TABLE AS SELECT merges SELECT params", () => {
    it("params from the inner SELECT survive into the compiled DDL", () => {
      const db = sumak({
        dialect: pgDialect(),
        tables: {
          users: {
            id: serial().primaryKey(),
            age: integer(),
          },
        },
      })
      const asSelect = db
        .selectFrom("users")
        .where(({ age }) => age.gt(18))
        .select("id")
        .build()
      const ddl = db.schema.createTable("adults").addColumn("id", "integer").build()
      const node = { ...ddl, asSelect }
      const r = db.compileDDL(node)
      expect(r.sql).toContain("CREATE TABLE")
      expect(r.params).toEqual([18])
    })
  })
})
