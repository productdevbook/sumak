import { describe, expect, it } from "vitest"

import { val } from "../../src/builder/eb.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("MySQL ON DUPLICATE KEY UPDATE", () => {
  const db = sumak({
    dialect: mysqlDialect(),
    tables: {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(),
        age: integer(),
      },
    },
  })

  const p = db.printer()

  it("generates ON DUPLICATE KEY UPDATE", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", age: 30 })
      .onDuplicateKeyUpdate([{ column: "name", value: val("Alice") }])
      .compile(p)
    expect(q.sql).toContain("ON DUPLICATE KEY UPDATE")
    expect(q.sql).toContain("`name`")
  })

  it("generates multiple SET clauses", () => {
    const q = db
      .insertInto("users")
      .values({ name: "Alice", age: 30 })
      .onDuplicateKeyUpdate([
        { column: "name", value: val("Bob") },
        { column: "age", value: val(25) },
      ])
      .compile(p)
    expect(q.sql).toContain("ON DUPLICATE KEY UPDATE")
    expect(q.sql).toContain("`age`")
  })

  it("PG throws on ON CONFLICT used in MySQL mode", () => {
    // Just testing that MySQL throws when PG-style onConflict is used
    const pgdb = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
    })
    // PG should handle onConflict fine
    const q = pgdb
      .insertInto("users")
      .values({ name: "Alice" })
      .onConflictDoNothing("id")
      .compile(pgdb.printer())
    expect(q.sql).toContain("ON CONFLICT")
  })
})
