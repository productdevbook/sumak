import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { AuditTimestampPlugin } from "../../src/plugin/audit-timestamp.ts"
import { softDelete } from "../../src/plugin/factories.ts"
import { MultiTenantPlugin } from "../../src/plugin/multi-tenant.ts"
import { integer, serial, text, timestamptz } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const usersTable = {
  id: serial().primaryKey(),
  name: text().notNull(),
  tenant_id: integer().defaultTo(0),
  deleted_at: timestamptz().nullable(),
  created_at: timestamptz().nullable(),
  updated_at: timestamptz().nullable(),
}

describe("MERGE × plugin combinations", () => {
  it("all three plugins compose on a single MERGE", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        softDelete({ tables: ["users"] }),
        new MultiTenantPlugin({ tables: ["users"], tenantId: 7 }),
        new AuditTimestampPlugin({ tables: ["users"] }),
      ],
      tables: {
        users: usersTable,
        staging: { id: serial().primaryKey(), name: text().notNull() },
      },
    })

    const q = db
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "updated" })
      .whenNotMatchedThenInsert({ name: "new" })
      .toSQL()

    // Soft-delete guard on ON.
    expect(q.sql).toContain('"users"."deleted_at" IS NULL')
    // Multi-tenant guard on ON.
    expect(q.sql).toContain('"users"."tenant_id" = $')
    // Audit-timestamp on UPDATE set.
    expect(q.sql).toContain('"updated_at" = CURRENT_TIMESTAMP')
    // Audit + tenant on INSERT columns.
    expect(q.sql).toContain('"created_at"')
    expect(q.sql).toContain('"tenant_id"')
  })

  it("soft-delete MERGE is idempotent — flag prevents double-apply", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        softDelete({ tables: ["users"] }),
        // Register twice — if the plugin weren't idempotent, ON would
        // grow two `IS NULL` predicates.
        softDelete({ tables: ["users"] }),
      ],
      tables: {
        users: usersTable,
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

    const occurrences = (q.sql.match(/"deleted_at" IS NULL/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})
