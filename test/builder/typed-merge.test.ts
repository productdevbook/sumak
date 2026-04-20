import { describe, expect, it } from "vitest"

import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
    },
    staging: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
    },
  },
})

const printer = db.printer()

describe("TypedMergeBuilder", () => {
  it("builds MERGE with whenMatchedThenUpdate", () => {
    const q = db
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "updated" })
    const r = q.compile(printer)
    expect(r.sql).toContain("MERGE INTO")
    expect(r.sql).toContain("USING")
    expect(r.sql).toContain("WHEN MATCHED THEN UPDATE SET")
    expect(r.params.length).toBeGreaterThan(0)
  })

  it("builds MERGE with whenNotMatchedThenInsert", () => {
    const q = db
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenNotMatchedThenInsert({ name: "Alice", email: "a@b.com" })
    const r = q.compile(printer)
    expect(r.sql).toContain("WHEN NOT MATCHED THEN INSERT")
    expect(r.sql).toContain("VALUES")
  })

  it("builds MERGE with whenMatchedThenDelete", () => {
    const q = db
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenDelete()
    const r = q.compile(printer)
    expect(r.sql).toContain("WHEN MATCHED THEN DELETE")
  })

  it("builds MERGE with multiple WHEN clauses", () => {
    const q = db
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "updated" })
      .whenNotMatchedThenInsert({ name: "new", email: "n@b.com" })
    const r = q.compile(printer)
    expect(r.sql).toContain("WHEN MATCHED")
    expect(r.sql).toContain("WHEN NOT MATCHED")
  })

  it("works with MSSQL dialect", () => {
    const mdb = sumak({
      dialect: mssqlDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
          email: text().notNull(),
        },
        staging: {
          id: serial().primaryKey(),
          name: text().notNull(),
          email: text().notNull(),
        },
      },
    })
    const q = mdb
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "Bob" })
      .whenNotMatchedThenInsert({ name: "Alice", email: "a@b.com" })
    const r = q.compile(mdb.printer())
    expect(r.sql).toContain("[users]")
    expect(r.sql).toContain("[staging]")
    expect(r.sql).toContain("@p")
  })
})

describe("mergeInto() — options-object form", () => {
  it("builds MERGE with { source, alias, on }", () => {
    const q = db
      .mergeInto("users", {
        source: "staging",
        alias: "s",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "updated" })
      .whenNotMatchedThenInsert({ name: "Alice", email: "a@b.com" })
    const r = q.compile(printer)
    expect(r.sql).toContain("MERGE INTO")
    expect(r.sql).toContain("USING")
    expect(r.sql).toContain('"s"')
    expect(r.sql).toContain("WHEN MATCHED THEN UPDATE SET")
    expect(r.sql).toContain("WHEN NOT MATCHED THEN INSERT")
  })

  it("alias defaults to source table name when omitted", () => {
    const q = db
      .mergeInto("users", {
        source: "staging",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ name: "x" })
    const r = q.compile(printer)
    expect(r.sql).toContain("MERGE INTO")
    expect(r.sql).toContain("USING")
    // Alias is the source name — the unaliased source appears in SQL.
    expect(r.sql).toContain('"staging"')
  })
})
