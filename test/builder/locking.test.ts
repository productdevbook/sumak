import { describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
    },
  },
})

const p = db.printer()

describe("Row locking", () => {
  it("FOR UPDATE", () => {
    const q = db.selectFrom("users").select("id").forUpdate().compile(p)
    expect(q.sql).toContain("FOR UPDATE")
  })

  it("FOR SHARE", () => {
    const q = db.selectFrom("users").select("id").forShare().compile(p)
    expect(q.sql).toContain("FOR SHARE")
  })

  it("FOR NO KEY UPDATE", () => {
    const q = db.selectFrom("users").select("id").forNoKeyUpdate().compile(p)
    expect(q.sql).toContain("FOR NO KEY UPDATE")
  })

  it("FOR KEY SHARE", () => {
    const q = db.selectFrom("users").select("id").forKeyShare().compile(p)
    expect(q.sql).toContain("FOR KEY SHARE")
  })

  it("FOR UPDATE NOWAIT", () => {
    const q = db.selectFrom("users").select("id").forUpdate().noWait().compile(p)
    expect(q.sql).toContain("FOR UPDATE NOWAIT")
  })

  it("FOR UPDATE SKIP LOCKED", () => {
    const q = db.selectFrom("users").select("id").forUpdate().skipLocked().compile(p)
    expect(q.sql).toContain("FOR UPDATE SKIP LOCKED")
  })

  it("FOR SHARE SKIP LOCKED", () => {
    const q = db.selectFrom("users").select("id").forShare().skipLocked().compile(p)
    expect(q.sql).toContain("FOR SHARE SKIP LOCKED")
  })

  it("MySQL supports FOR UPDATE", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    const q = mydb.selectFrom("users").select("id").forUpdate().compile(mydb.printer())
    expect(q.sql).toContain("FOR UPDATE")
  })

  it("MySQL supports FOR SHARE", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    const q = mydb.selectFrom("users").select("id").forShare().compile(mydb.printer())
    expect(q.sql).toContain("FOR SHARE")
  })

  it("MSSQL throws on FOR UPDATE", () => {
    const msdb = sumak({
      dialect: mssqlDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    expect(() =>
      msdb.selectFrom("users").select("id").forUpdate().compile(msdb.printer()),
    ).toThrow()
  })

  it("SQLite throws on FOR UPDATE", () => {
    const sldb = sumak({
      dialect: sqliteDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    expect(() =>
      sldb.selectFrom("users").select("id").forUpdate().compile(sldb.printer()),
    ).toThrow()
  })
})
