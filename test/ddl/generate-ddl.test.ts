import { describe, expect, it } from "vitest"

import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sqliteDialect } from "../../src/dialect/sqlite.ts"
import { boolean, integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("generateDDL — auto CREATE TABLE from schema", () => {
  it("generates CREATE TABLE for single table", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          email: text().notNull(),
        },
      },
    })

    const ddl = db.generateDDL()
    expect(ddl).toHaveLength(1)
    expect(ddl[0]!.sql).toContain("CREATE TABLE")
    expect(ddl[0]!.sql).toContain('"users"')
    expect(ddl[0]!.sql).toContain("PRIMARY KEY")
    expect(ddl[0]!.sql).toContain("NOT NULL")
  })

  it("generates for multiple tables", () => {
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
          userId: integer().references("users", "id"),
        },
      },
    })

    const ddl = db.generateDDL()
    expect(ddl).toHaveLength(2)

    const usersSql = ddl.find((d) => d.sql.includes('"users"'))
    const postsSql = ddl.find((d) => d.sql.includes('"posts"'))
    expect(usersSql).toBeDefined()
    expect(postsSql).toBeDefined()
    expect(postsSql!.sql).toContain("REFERENCES")
  })

  it("IF NOT EXISTS option", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: { id: serial().primaryKey() },
      },
    })

    const ddl = db.generateDDL({ ifNotExists: true })
    expect(ddl[0]!.sql).toContain("IF NOT EXISTS")
  })

  it("MySQL dialect", () => {
    const db = sumak({
      dialect: mysqlDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
    })

    const ddl = db.generateDDL()
    expect(ddl[0]!.sql).toContain("`users`")
    expect(ddl[0]!.sql).toContain("`id`")
  })

  it("SQLite dialect", () => {
    const db = sumak({
      dialect: sqliteDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
    })

    const ddl = db.generateDDL()
    expect(ddl[0]!.sql).toContain('"users"')
  })

  it("includes column types", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          age: integer(),
          active: boolean(),
        },
      },
    })

    const ddl = db.generateDDL()
    const sql = ddl[0]!.sql
    expect(sql).toContain("serial")
    expect(sql).toContain("text")
    expect(sql).toContain("integer")
    expect(sql).toContain("boolean")
  })

  it("handles foreign key references", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        posts: {
          id: serial().primaryKey(),
          userId: integer().references("users", "id"),
        },
      },
    })

    const ddl = db.generateDDL()
    expect(ddl[0]!.sql).toContain("REFERENCES")
    expect(ddl[0]!.sql).toContain('"users"')
    expect(ddl[0]!.sql).toContain('"id"')
  })

  it("empty tables returns empty array", () => {
    const db = sumak({ dialect: pgDialect(), tables: {} })
    const ddl = db.generateDDL()
    expect(ddl).toHaveLength(0)
  })
})
