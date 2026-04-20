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

  it("MERGE isolates source too when source is a tenant-aware table", () => {
    // Both target and source are `users`, both tenant-aware.
    // ON must now include BOTH target.tenant_id = ? AND source.tenant_id = ?
    // otherwise a cross-tenant source row could update a same-tenant target.
    const q = db
      .mergeInto("users", {
        source: "users",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "x" })
      .toSQL()
    expect(q.sql).toContain('"users"."tenant_id" = $')
    expect(q.sql).toContain('"s"."tenant_id" = $')
    // Both guards reference the configured tenant value (42).
    expect(q.params.filter((p) => p === 42).length).toBeGreaterThanOrEqual(2)
  })

  it("MERGE source isolation is skipped when source is not tenant-aware", () => {
    // `non_tenant` isn't registered with the plugin — no source guard.
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [new MultiTenantPlugin({ tables: ["users"], tenantId: 42 })],
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          tenant_id: integer().defaultTo(0),
        },
        non_tenant: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db2
      .mergeInto("users", {
        source: "non_tenant",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "x" })
      .toSQL()
    // Target guard present.
    expect(q.sql).toContain('"users"."tenant_id" = $')
    // No source guard — source table has no tenant_id column.
    expect(q.sql).not.toContain('"s"."tenant_id"')
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
    // tenant_id appears: target guard, source guard (source is also
    // tenant-aware), and once in INSERT — three total, not four (no dupe).
    const matches = q.sql.match(/"tenant_id"/g) ?? []
    expect(matches.length).toBe(3)
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
