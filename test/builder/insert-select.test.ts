import { describe, expect, it } from "vitest"

import { InsertBuilder } from "../../src/builder/insert.ts"
import { SelectBuilder } from "../../src/builder/select.ts"
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
      age: integer(),
    },
    archive: {
      id: serial().primaryKey(),
      name: text().notNull(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("INSERT ... SELECT", () => {
  it("untyped INSERT ... SELECT", () => {
    const selectQuery = new SelectBuilder().columns("name", "age").from("users").build()
    const q = new InsertBuilder()
      .into("archive")
      .columns("name", "age")
      .fromSelect(selectQuery)
      .build()
    expect(q.source).toBeDefined()
    expect(q.source!.type).toBe("select")
  })

  it("typed INSERT ... SELECT in PG", () => {
    const selectQuery = db.selectFrom("users").select("name", "age").build()
    const q = db.insertInto("archive").fromSelect(selectQuery).compile(p)
    expect(q.sql).toContain("INSERT INTO")
    expect(q.sql).toContain("SELECT")
    expect(q.sql).not.toContain("VALUES")
  })

  it("INSERT ... SELECT in MySQL", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
        archive: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const selectQuery = mydb.selectFrom("users").select("name").build()
    const q = mydb.insertInto("archive").fromSelect(selectQuery).compile(mydb.printer())
    expect(q.sql).toContain("INSERT INTO")
    expect(q.sql).toContain("SELECT")
  })

  it("INSERT ... SELECT in SQLite", () => {
    const sldb = sumak({
      dialect: sqliteDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
        archive: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const selectQuery = sldb.selectFrom("users").select("name").build()
    const q = sldb.insertInto("archive").fromSelect(selectQuery).compile(sldb.printer())
    expect(q.sql).toContain("INSERT INTO")
    expect(q.sql).toContain("SELECT")
  })

  it("INSERT ... SELECT in MSSQL", () => {
    const msdb = sumak({
      dialect: mssqlDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
        archive: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const selectQuery = msdb.selectFrom("users").select("name").build()
    const q = msdb.insertInto("archive").fromSelect(selectQuery).compile(msdb.printer())
    expect(q.sql).toContain("INSERT INTO")
    expect(q.sql).toContain("SELECT")
  })
})

describe("INSERT ... DEFAULT VALUES", () => {
  it("untyped DEFAULT VALUES", () => {
    const q = new InsertBuilder().into("users").defaultValues().build()
    expect(q.defaultValues).toBe(true)
  })

  it("typed DEFAULT VALUES in PG", () => {
    const q = db.insertInto("users").defaultValues().compile(p)
    expect(q.sql).toContain("DEFAULT VALUES")
    expect(q.sql).not.toContain("VALUES (")
  })

  it("DEFAULT VALUES in MSSQL", () => {
    const msdb = sumak({
      dialect: mssqlDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = msdb.insertInto("users").defaultValues().compile(msdb.printer())
    expect(q.sql).toContain("DEFAULT VALUES")
  })
})
