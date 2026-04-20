import { describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { softDelete } from "../../src/plugin/factories.ts"
import { SoftDeletePlugin } from "../../src/plugin/soft-delete.ts"
import { boolean, serial, text, timestamptz } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const usersTable = {
  id: serial().primaryKey(),
  name: text().notNull(),
  deleted_at: timestamptz(),
}

function makeDb(cfg?: Parameters<typeof softDelete>[0]) {
  return sumak({
    dialect: pgDialect(),
    plugins: cfg ? [softDelete(cfg)] : [],
    tables: { users: usersTable },
  })
}

describe("SoftDeletePlugin — filter only (no convert mode)", () => {
  const db = makeDb({ tables: ["users"] })

  it("SELECT auto-filters deleted rows", () => {
    const q = db.selectFrom("users").select("id", "name").toSQL()
    expect(q.sql).toContain('"deleted_at" IS NULL')
  })

  it("UPDATE auto-filters deleted rows", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain('"deleted_at" IS NULL')
  })

  it("DELETE is NOT rewritten — hard delete stays hard", () => {
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/^DELETE FROM/)
    expect(q.sql).not.toContain("UPDATE")
    expect(q.sql).not.toContain("deleted_at")
  })

  it("non-configured table is untouched", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [softDelete({ tables: ["posts"] })],
      tables: { users: usersTable },
    })
    const q = db2.selectFrom("users").select("id").toSQL()
    expect(q.sql).not.toContain("deleted_at")
  })

  it("custom column name is honored", () => {
    const db2 = makeDb({ tables: ["users"], column: "removed_at" })
    const q = db2.selectFrom("users").select("id").toSQL()
    expect(q.sql).toContain('"removed_at" IS NULL')
  })

  it("boolean flag uses WHERE deleted = FALSE", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [softDelete({ tables: ["users"], flag: "boolean", column: "deleted" })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull(), deleted: boolean() },
      },
    })
    const q = db2.selectFrom("users").select("id").toSQL()
    // Printer renders FALSE literal as FALSE.
    expect(q.sql).toMatch(/"deleted"\s*=\s*FALSE/i)
  })
})

describe(".includeDeleted() bypass", () => {
  const db = makeDb({ tables: ["users"] })

  it("SELECT .includeDeleted() emits no filter", () => {
    const q = db.selectFrom("users").select("id").includeDeleted().toSQL()
    expect(q.sql).not.toContain("deleted_at")
  })

  it("UPDATE .includeDeleted() emits no filter", () => {
    const q = db
      .update("users")
      .set({ name: "x" })
      .where(({ id }) => id.eq(1))
      .includeDeleted()
      .toSQL()
    expect(q.sql).not.toContain("deleted_at")
  })
})

describe(".onlyDeleted() inversion", () => {
  const db = makeDb({ tables: ["users"] })

  it("SELECT .onlyDeleted() emits IS NOT NULL", () => {
    const q = db.selectFrom("users").select("id").onlyDeleted().toSQL()
    expect(q.sql).toContain("IS NOT NULL")
    expect(q.sql).not.toMatch(/IS NULL(?!\s+THEN)/) // "IS NULL" alone shouldn't appear
  })
})

describe("db.softDelete() — explicit write builder", () => {
  const db = makeDb({ tables: ["users"] })

  it("generates UPDATE SET deleted_at = CURRENT_TIMESTAMP with race-safe predicate", () => {
    const q = db
      .softDelete("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/UPDATE "users" SET "deleted_at" = CURRENT_TIMESTAMP/)
    expect(q.sql).toContain('"deleted_at" IS NULL')
    // user's predicate and race-safe predicate are ANDed.
    expect(q.sql).toMatch(/WHERE \(.*"id" = \$1.*\) AND .*"deleted_at" IS NULL/)
  })

  it("supports returning / returningAll", () => {
    const a = db
      .softDelete("users")
      .where(({ id }) => id.eq(1))
      .returning("id")
      .toSQL()
    expect(a.sql).toMatch(/RETURNING "id"/)

    const b = db
      .softDelete("users")
      .where(({ id }) => id.eq(1))
      .returningAll()
      .toSQL()
    expect(b.sql).toContain("RETURNING *")
  })

  it("throws if plugin not registered", () => {
    const db2 = makeDb() // no plugin
    expect(() => db2.softDelete("users")).toThrow(/requires the softDelete plugin/)
  })

  it("throws if table not in plugin config", () => {
    const db2 = makeDb({ tables: ["posts"] })
    expect(() => db2.softDelete("users")).toThrow(/not configured for soft-delete/)
  })

  it("boolean flag writes TRUE", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [softDelete({ tables: ["users"], flag: "boolean", column: "deleted" })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull(), deleted: boolean() },
      },
    })
    const q = db2
      .softDelete("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/SET "deleted" = TRUE/i)
    expect(q.sql).toMatch(/"deleted"\s*=\s*FALSE/i)
  })
})

describe("db.restore() — explicit restore builder", () => {
  const db = makeDb({ tables: ["users"] })

  it("generates UPDATE SET deleted_at = NULL with race-safe IS NOT NULL", () => {
    const q = db
      .restore("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/UPDATE "users" SET "deleted_at" = NULL/)
    expect(q.sql).toContain('"deleted_at" IS NOT NULL')
  })

  it("throws if plugin not registered", () => {
    const db2 = makeDb()
    expect(() => db2.restore("users")).toThrow(/requires the softDelete plugin/)
  })

  it("boolean flag writes FALSE", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [softDelete({ tables: ["users"], flag: "boolean", column: "deleted" })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull(), deleted: boolean() },
      },
    })
    const q = db2
      .restore("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/SET "deleted" = FALSE/i)
    expect(q.sql).toMatch(/"deleted"\s*=\s*TRUE/i)
  })
})

describe("plugin idempotency via QueryFlags", () => {
  const db = makeDb({ tables: ["users"] })

  it("running the plugin twice does not double-inject", () => {
    const plugin = new SoftDeletePlugin({ tables: ["users"] })
    const node = db.selectFrom("users").select("id").build()
    const once = plugin.transformNode(node)
    const twice = plugin.transformNode(once)
    // Same reference, no additional AND layer.
    expect(twice).toBe(once)
  })
})

describe("double-chain .where() — user predicates are AND-accumulated", () => {
  const db = makeDb({ tables: ["users"] })

  it("two .where() calls both land in the SQL, race-safe predicate still last", () => {
    const q = db
      .softDelete("users")
      .where(({ id }) => id.eq(1))
      .where(({ name }) => name.eq("alice"))
      .toSQL()
    // Both user predicates survive.
    expect(q.sql).toContain('"id" = $1')
    expect(q.sql).toContain('"name" = $2')
    // Race-safe predicate is last — parens in the generated SQL vary.
    expect(q.sql).toMatch(/"name" = \$2.*AND.*"deleted_at" IS NULL/)
  })

  it("three .where() calls on restore all survive", () => {
    const q = db
      .restore("users")
      .where(({ id }) => id.eq(1))
      .where(({ id }) => id.gt(0))
      .where(({ name }) => name.eq("x"))
      .toSQL()
    expect(q.sql).toContain('"id" = $1')
    expect(q.sql).toContain('"id" > $2')
    expect(q.sql).toContain('"name" = $3')
    expect(q.sql).toContain("IS NOT NULL")
  })
})

describe("JOIN — soft-delete filter behaviour per join type", () => {
  const db = sumak({
    dialect: pgDialect(),
    plugins: [softDelete({ tables: ["users"] })],
    tables: {
      users: usersTable,
      orders: {
        id: serial().primaryKey(),
        user_id: serial(),
        total: serial(),
      },
    },
  })

  it("INNER JOIN to a soft-delete table gets ON ... AND deleted_at IS NULL", () => {
    const q = db
      .selectFrom("orders")
      .innerJoin("users", ({ orders, users }) => orders.user_id.eq(users.id))
      .select("id")
      .toSQL()
    expect(q.sql).toMatch(/JOIN "users" ON .*"deleted_at" IS NULL/)
  })

  it("LEFT JOIN is NOT rewritten — adding IS NULL to ON would null-out columns, not hide rows", () => {
    const q = db
      .selectFrom("orders")
      .leftJoin("users", ({ orders, users }) => orders.user_id.eq(users.id))
      .select("id")
      .toSQL()
    // LEFT JOIN to a soft-delete table must NOT get the predicate added
    // to ON — it would be a silent semantic change. User must filter in
    // WHERE or use INNER JOIN explicitly.
    expect(q.sql).toMatch(
      /LEFT JOIN "users" ON \("orders"\."user_id" = "users"\."id"\)(?!.*deleted_at)/,
    )
    expect(q.sql).not.toContain("deleted_at")
  })

  it("FROM-less join case: when soft-delete table is only in FROM, WHERE filter still applies", () => {
    const q = db.selectFrom("users").select("id").toSQL()
    expect(q.sql).toMatch(/WHERE \(?"deleted_at" IS NULL\)?/)
  })
})

describe("includeDeleted + onlyDeleted precedence — last call wins", () => {
  const db = makeDb({ tables: ["users"] })

  it("includeDeleted().onlyDeleted() → onlyDeleted wins (IS NOT NULL)", () => {
    const q = db.selectFrom("users").select("id").includeDeleted().onlyDeleted().toSQL()
    expect(q.sql).toContain("IS NOT NULL")
  })

  it("onlyDeleted().includeDeleted() → includeDeleted wins (no filter)", () => {
    const q = db.selectFrom("users").select("id").onlyDeleted().includeDeleted().toSQL()
    expect(q.sql).not.toContain("deleted_at")
  })
})

describe("SoftDeleteBuilder.returning() accumulates across chained calls", () => {
  const db = makeDb({ tables: ["users"] })

  it("two .returning() calls → both columns", () => {
    const q = db
      .softDelete("users")
      .where(({ id }) => id.eq(1))
      .returning("id")
      .returning("name")
      .toSQL()
    expect(q.sql).toMatch(/RETURNING "id", "name"/)
  })

  it(".returningAll() discards any accumulated returning list", () => {
    const q = db
      .softDelete("users")
      .where(({ id }) => id.eq(1))
      .returning("id")
      .returningAll()
      .toSQL()
    expect(q.sql).toContain("RETURNING *")
    expect(q.sql).not.toMatch(/RETURNING "id"/)
  })
})

describe("dialect portability — CURRENT_TIMESTAMP is printed without parens", () => {
  for (const [name, dialect] of [
    ["pg", pgDialect()],
    ["mysql", mysqlDialect()],
    ["sqlite", sqliteDialect()],
    ["mssql", mssqlDialect()],
  ] as const) {
    it(`${name}: softDelete emits bare CURRENT_TIMESTAMP (SQL:92 keyword)`, () => {
      const db = sumak({
        dialect,
        plugins: [softDelete({ tables: ["users"] })],
        tables: { users: usersTable },
      })
      const q = db
        .softDelete("users")
        .where(({ id }) => id.eq(1))
        .toSQL()
      expect(q.sql).toMatch(/\bCURRENT_TIMESTAMP\b/)
      // Critical for MSSQL: no parens after the keyword.
      expect(q.sql).not.toMatch(/CURRENT_TIMESTAMP\s*\(/)
      // NOW() should not appear (it's not portable).
      expect(q.sql).not.toContain("NOW()")
    })
  }
})

describe("SoftDeletePlugin + MERGE", () => {
  const db = sumak({
    dialect: pgDialect(),
    plugins: [softDelete({ tables: ["users"] })],
    tables: {
      users: usersTable,
      staging: { id: serial().primaryKey(), name: text().notNull() },
    },
  })

  it("qualifies ON with target.deleted_at IS NULL — deleted rows don't match", () => {
    const q = db
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "updated" })
      .toSQL()
    expect(q.sql).toContain('"users"."deleted_at" IS NULL')
  })

  it("boolean-flag variant qualifies ON with target.deleted = FALSE", () => {
    const boolDb = sumak({
      dialect: pgDialect(),
      plugins: [softDelete({ tables: ["users"], flag: "boolean" })],
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          deleted: boolean().defaultTo(false),
        },
        staging: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = boolDb
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "x" })
      .toSQL()
    expect(q.sql).toContain('"users"."deleted" = FALSE')
  })

  it("non-target MERGE is left alone", () => {
    const otherDb = sumak({
      dialect: pgDialect(),
      plugins: [softDelete({ tables: ["users"] })],
      tables: {
        users: usersTable,
        staging: { id: serial().primaryKey(), name: text().notNull() },
        other: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = otherDb
      .mergeInto("other", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "x" })
      .toSQL()
    expect(q.sql).not.toContain("deleted_at")
  })
})

describe("direct integration: writes via softDelete mutate state such that filter hides them", () => {
  const db = makeDb({ tables: ["users"] })

  it("after softDelete, a plain SELECT should not see the row (SQL shape check)", () => {
    const del = db
      .softDelete("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    // The UPDATE sets the column; a subsequent SELECT would filter it out.
    expect(del.sql).toContain("CURRENT_TIMESTAMP")
    const sel = db.selectFrom("users").select("id").toSQL()
    expect(sel.sql).toContain('"deleted_at" IS NULL')
  })

  it("after softDelete, onlyDeleted() sees the row", () => {
    const sel = db.selectFrom("users").select("id").onlyDeleted().toSQL()
    expect(sel.sql).toContain("IS NOT NULL")
  })
})
