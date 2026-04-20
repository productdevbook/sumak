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
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
    },
  },
})

const p = db.printer()

describe("Row locking", () => {
  it("FOR UPDATE", () => {
    const q = db.selectFrom("users").select("id").lock({ mode: "update" }).compile(p)
    expect(q.sql).toContain("FOR UPDATE")
  })

  it("FOR SHARE", () => {
    const q = db.selectFrom("users").select("id").lock({ mode: "share" }).compile(p)
    expect(q.sql).toContain("FOR SHARE")
  })

  it("FOR NO KEY UPDATE", () => {
    const q = db.selectFrom("users").select("id").lock({ mode: "no_key_update" }).compile(p)
    expect(q.sql).toContain("FOR NO KEY UPDATE")
  })

  it("FOR KEY SHARE", () => {
    const q = db.selectFrom("users").select("id").lock({ mode: "key_share" }).compile(p)
    expect(q.sql).toContain("FOR KEY SHARE")
  })

  it("FOR UPDATE NOWAIT", () => {
    const q = db.selectFrom("users").select("id").lock({ mode: "update", noWait: true }).compile(p)
    expect(q.sql).toContain("FOR UPDATE NOWAIT")
  })

  it("FOR UPDATE SKIP LOCKED", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .lock({ mode: "update", skipLocked: true })
      .compile(p)
    expect(q.sql).toContain("FOR UPDATE SKIP LOCKED")
  })

  it("FOR SHARE SKIP LOCKED", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .lock({ mode: "share", skipLocked: true })
      .compile(p)
    expect(q.sql).toContain("FOR SHARE SKIP LOCKED")
  })

  it("FOR UPDATE OF <table> (PG multi-table lock scoping)", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .lock({ mode: "update", of: ["users"] })
      .compile(p)
    expect(q.sql).toContain('FOR UPDATE OF "users"')
  })

  it("FOR UPDATE OF <multiple tables>", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .lock({ mode: "update", of: ["users", "posts"], noWait: true })
      .compile(p)
    expect(q.sql).toContain('FOR UPDATE OF "users", "posts" NOWAIT')
  })

  it("MySQL supports FOR UPDATE", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    const q = mydb.selectFrom("users").select("id").lock({ mode: "update" }).compile(mydb.printer())
    expect(q.sql).toContain("FOR UPDATE")
  })

  it("MySQL supports FOR SHARE", () => {
    const mydb = sumak({
      dialect: mysqlDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    const q = mydb.selectFrom("users").select("id").lock({ mode: "share" }).compile(mydb.printer())
    expect(q.sql).toContain("FOR SHARE")
  })

  it("MSSQL throws on FOR UPDATE", () => {
    const msdb = sumak({
      dialect: mssqlDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    expect(() =>
      msdb.selectFrom("users").select("id").lock({ mode: "update" }).compile(msdb.printer()),
    ).toThrow()
  })

  it("SQLite throws on FOR UPDATE", () => {
    const sldb = sumak({
      dialect: sqliteDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    expect(() =>
      sldb.selectFrom("users").select("id").lock({ mode: "update" }).compile(sldb.printer()),
    ).toThrow()
  })
})
