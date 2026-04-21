import { describe, expect, it } from "vitest"

import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("SQLite INSERT OR IGNORE / INSERT OR REPLACE", () => {
  const db = sumak({
    dialect: sqliteDialect(),
    tables: {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(),
      },
    },
  })

  const p = db.printer()

  it("INSERT OR IGNORE", () => {
    const q = db.insertInto("users").values({ name: "Alice" }).orIgnore().compile(p)
    expect(q.sql).toContain("INSERT OR IGNORE INTO")
    expect(q.sql).not.toContain("INSERT INSERT")
  })

  it("INSERT OR REPLACE", () => {
    const q = db.insertInto("users").values({ name: "Alice" }).orReplace().compile(p)
    expect(q.sql).toContain("INSERT OR REPLACE INTO")
  })

  it("normal INSERT still works", () => {
    const q = db.insertInto("users").values({ name: "Alice" }).compile(p)
    expect(q.sql).toMatch(/^INSERT INTO/)
  })

  it("works in PG too", () => {
    const pgdb = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    // `INSERT OR IGNORE` is SQLite-only syntax — non-SQLite dialects
    // now reject the node rather than emit invalid SQL.
    expect(() =>
      pgdb.insertInto("users").values({ name: "Alice" }).orIgnore().compile(pgdb.printer()),
    ).toThrow(/SQLite-only/)
  })

  it("MySQL rejects .orIgnore() — suggests onDuplicateKeyUpdate", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    expect(() =>
      mydb.insertInto("users").values({ name: "Alice" }).orIgnore().compile(mydb.printer()),
    ).toThrow(/SQLite-only/)
  })
})
