import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { CursorPaginationPlugin } from "../../src/plugin/cursor-pagination.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("CursorPaginationPlugin", () => {
  it("adds LIMIT pageSize + 1 without cursor", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [new CursorPaginationPlugin({ pageSize: 20 })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.selectFrom("users").select("id", "name").toSQL()
    expect(q.sql).toContain("LIMIT 21")
  })

  it("adds WHERE id > cursor for ASC", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        new CursorPaginationPlugin({
          pageSize: 10,
          cursor: { column: "id", value: 42, direction: "ASC" },
        }),
      ],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.selectFrom("users").select("id", "name").toSQL()
    expect(q.params).toContain(42)
    expect(q.sql).toContain("LIMIT 11")
  })

  it("adds WHERE id < cursor for DESC", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        new CursorPaginationPlugin({
          pageSize: 10,
          cursor: { column: "id", value: 100, direction: "DESC" },
        }),
      ],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.selectFrom("users").select("id", "name").toSQL()
    expect(q.params).toContain(100)
  })

  it("preserves existing WHERE", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        new CursorPaginationPlugin({
          pageSize: 10,
          cursor: { column: "id", value: 5 },
        }),
      ],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ name }) => name.eq("Alice"))
      .toSQL()
    expect(q.sql).toContain("AND")
    expect(q.params).toContain("Alice")
    expect(q.params).toContain(5)
  })

  it("does not affect INSERT", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [new CursorPaginationPlugin({ pageSize: 10 })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.insertInto("users").values({ name: "Alice" }).toSQL()
    expect(q.sql).not.toContain("LIMIT 11")
  })

  it("does not override explicit LIMIT", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [new CursorPaginationPlugin({ pageSize: 20 })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.selectFrom("users").select("id").limit(5).toSQL()
    expect(q.sql).toContain("LIMIT 5")
    expect(q.sql).not.toContain("LIMIT 21")
  })
})
