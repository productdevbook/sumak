import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { OptimisticLockPlugin } from "../../src/plugin/optimistic-lock.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("OptimisticLockPlugin", () => {
  const db = sumak({
    dialect: pgDialect(),
    plugins: [new OptimisticLockPlugin({ tables: ["users"], currentVersion: 3 })],
    tables: {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(),
        version: integer().defaultTo(1),
      },
    },
  })

  it("UPDATE adds SET version = version + 1", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain('"version"')
    expect(q.sql).toContain("+ 1")
  })

  it("UPDATE adds WHERE version = currentVersion", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.params).toContain(3)
  })

  it("SELECT is not affected", () => {
    const q = db.selectFrom("users").select("id").toSQL()
    expect(q.sql).not.toContain("+ 1")
    expect(q.params).not.toContain(3)
  })

  it("INSERT seeds the version column (does not add version+1 increment)", () => {
    const q = db.insertInto("users").values({ name: "Alice" }).toSQL()
    // The UPDATE-only `version = version + 1` must never appear on INSERT.
    expect(q.sql).not.toContain("+ 1")
    // Since audit #19 the plugin seeds the version column so the row
    // isn't NULL (which would lock it out of every subsequent UPDATE's
    // `WHERE version = :current` check). The column name should now
    // appear in the INSERT.
    expect(q.sql).toContain('"version"')
  })

  it("non-configured table not affected", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [new OptimisticLockPlugin({ tables: ["posts"], currentVersion: 1 })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db2
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).not.toContain("+ 1")
  })

  it("custom column name", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [new OptimisticLockPlugin({ tables: ["users"], column: "rev", currentVersion: 5 })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db2
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain('"rev"')
    expect(q.params).toContain(5)
  })

  it("callback version — changes per query", () => {
    let version = 3
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [new OptimisticLockPlugin({ tables: ["users"], currentVersion: () => version })],
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          version: integer().defaultTo(1),
        },
      },
    })

    const q1 = db2
      .update("users")
      .set({ name: "A" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q1.params).toContain(3)

    version = 7
    const q2 = db2
      .update("users")
      .set({ name: "B" })
      .where(({ id }) => id.eq(2))
      .toSQL()
    expect(q2.params).toContain(7)
  })
})
