import { describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      dept: text().notNull(),
      salary: integer(),
    },
  },
})

const p = db.printer()

describe("DISTINCT ON (PG)", () => {
  it("single column DISTINCT ON", () => {
    const q = db
      .selectFrom("users")
      .selectAll()
      .distinctOn("dept")
      .orderBy("dept")
      .orderBy("salary", "DESC")
      .compile(p)
    expect(q.sql).toContain('DISTINCT ON ("dept")')
    expect(q.sql).not.toContain("DISTINCT DISTINCT")
  })

  it("multi-column DISTINCT ON", () => {
    const q = db.selectFrom("users").select("id", "name").distinctOn("dept", "name").compile(p)
    expect(q.sql).toContain('DISTINCT ON ("dept", "name")')
  })

  it("MySQL throws on DISTINCT ON", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: { users: { id: serial().primaryKey(), dept: text().notNull() } },
    })
    expect(() =>
      mydb.selectFrom("users").select("id").distinctOn("dept").compile(mydb.printer()),
    ).toThrow("DISTINCT ON")
  })

  it("SQLite throws on DISTINCT ON", () => {
    const sldb = sumak({
      dialect: sqliteDialect(),
      tables: { users: { id: serial().primaryKey(), dept: text().notNull() } },
    })
    expect(() =>
      sldb.selectFrom("users").select("id").distinctOn("dept").compile(sldb.printer()),
    ).toThrow("DISTINCT ON")
  })

  it("MSSQL throws on DISTINCT ON", () => {
    const msdb = sumak({
      dialect: mssqlDialect(),
      tables: { users: { id: serial().primaryKey(), dept: text().notNull() } },
    })
    expect(() =>
      msdb.selectFrom("users").select("id").distinctOn("dept").compile(msdb.printer()),
    ).toThrow("DISTINCT ON")
  })
})
