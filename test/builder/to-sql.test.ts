import { describe, expect, it } from "vitest"

import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      age: integer(),
    },
  },
})

describe(".toSQL() on typed builders", () => {
  it("SELECT .toSQL()", () => {
    const q = db.selectFrom("users").select("id", "name").toSQL()
    expect(q.sql).toContain("SELECT")
    expect(q.sql).toContain('"users"')
  })

  it("SELECT with WHERE .toSQL()", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.gt(18))
      .toSQL()
    expect(q.sql).toContain("WHERE")
    expect(q.params.length).toBeGreaterThan(0)
  })

  it("INSERT .toSQL()", () => {
    const q = db.insertInto("users").values({ name: "Alice", age: 30 }).toSQL()
    expect(q.sql).toContain("INSERT INTO")
    expect(q.params).toContain("Alice")
  })

  it("UPDATE .toSQL()", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain("UPDATE")
    expect(q.sql).toContain("SET")
  })

  it("DELETE .toSQL()", () => {
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain("DELETE FROM")
  })

  it("chained methods preserve printer", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ age }) => age.gt(0))
      .orderBy("id")
      .limit(10)
      .toSQL()
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("LIMIT")
  })

  it("MySQL dialect .toSQL()", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = mydb.selectFrom("users").select("id").toSQL()
    expect(q.sql).toContain("`users`")
    expect(q.sql).toContain("`id`")
  })

  it(".compile(printer) still works", () => {
    const q = db.selectFrom("users").select("id").compile(db.printer())
    expect(q.sql).toContain("SELECT")
  })
})
