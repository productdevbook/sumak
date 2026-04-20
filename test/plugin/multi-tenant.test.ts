import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { MultiTenantPlugin } from "../../src/plugin/multi-tenant.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("MultiTenantPlugin", () => {
  const db = sumak({
    dialect: pgDialect(),
    plugins: [new MultiTenantPlugin({ tables: ["users", "posts"], tenantId: 42 })],
    tables: {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(),
        tenant_id: integer().defaultTo(0),
      },
      posts: {
        id: serial().primaryKey(),
        title: text().notNull(),
        tenant_id: integer().defaultTo(0),
      },
    },
  })

  it("SELECT adds WHERE tenant_id = ?", () => {
    const q = db.selectFrom("users").select("id", "name").toSQL()
    expect(q.sql).toContain('"tenant_id"')
    expect(q.params).toContain(42)
  })

  it("SELECT with existing WHERE ANDs tenant filter", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ name }) => name.eq("Alice"))
      .toSQL()
    expect(q.sql).toContain("AND")
    expect(q.params).toContain(42)
  })

  it("UPDATE adds WHERE tenant_id = ?", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain('"tenant_id"')
    expect(q.params).toContain(42)
  })

  it("DELETE adds WHERE tenant_id = ?", () => {
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain('"tenant_id"')
    expect(q.params).toContain(42)
  })

  it("INSERT adds tenant_id column and value", () => {
    const q = db.insertInto("users").values({ name: "Alice" }).toSQL()
    expect(q.sql).toContain('"tenant_id"')
    expect(q.params).toContain(42)
  })

  it("works across different tables", () => {
    const q = db.selectFrom("posts").select("id", "title").toSQL()
    expect(q.params).toContain(42)
  })

  it("custom column name", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [new MultiTenantPlugin({ tables: ["users"], column: "org_id", tenantId: "abc" })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db2.selectFrom("users").select("id").toSQL()
    expect(q.sql).toContain('"org_id"')
    expect(q.params).toContain("abc")
  })

  it("MERGE qualifies ON with target.tenant_id — blocks cross-tenant matches", () => {
    const q = db
      .mergeInto("users", {
        source: "users",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "x" })
      .toSQL()
    // The ON predicate must now include the target tenant_id guard.
    expect(q.sql).toContain('"users"."tenant_id" = $')
    expect(q.params).toContain(42)
  })

  it("MERGE WHEN NOT MATCHED INSERT injects tenant_id column + value", () => {
    const q = db
      .mergeInto("users", {
        source: "users",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenNotMatchedThenInsert({ name: "Alice" })
      .toSQL()
    expect(q.sql).toContain('"tenant_id"')
    expect(q.sql).toContain("INSERT")
    // tenant_id value is the configured 42 — check it's in params at least once.
    expect(q.params.filter((p) => p === 42).length).toBeGreaterThanOrEqual(2)
  })

  it("MERGE INSERT does not double-inject if caller already set tenant_id", () => {
    const q = db
      .mergeInto("users", {
        source: "users",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenNotMatchedThenInsert({ name: "Alice", tenant_id: 42 } as any)
      .toSQL()
    // tenant_id appears exactly once in the INSERT column list.
    const matches = q.sql.match(/"tenant_id"/g) ?? []
    // One in ON predicate, one in INSERT column list — total 2.
    expect(matches.length).toBe(2)
  })

  it("callback tenantId — changes per request", () => {
    let currentTenant = 10
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [new MultiTenantPlugin({ tables: ["users"], tenantId: () => currentTenant })],
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          tenant_id: integer().defaultTo(0),
        },
      },
    })

    const q1 = db2.selectFrom("users").select("id").toSQL()
    expect(q1.params).toContain(10)

    currentTenant = 99
    const q2 = db2.selectFrom("users").select("id").toSQL()
    expect(q2.params).toContain(99)
  })
})
