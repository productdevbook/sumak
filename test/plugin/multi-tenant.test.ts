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
})
