import { describe, expect, it } from "vitest"

import { lit, param } from "../../src/ast/expression.ts"
import { mssqlDialect } from "../../src/dialect/mssql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      validFrom: timestamp(),
      validTo: timestamp(),
    },
  },
})

const p = db.printer()

describe("Temporal Tables (SQL:2011)", () => {
  it("FOR SYSTEM_TIME AS OF", () => {
    const q = db.selectFrom("users").forSystemTime({ kind: "as_of", timestamp: lit("2024-01-01") })
    const r = q.compile(p)
    expect(r.sql).toContain("FOR SYSTEM_TIME AS OF")
    expect(r.sql).toContain("'2024-01-01'")
  })

  it("FOR SYSTEM_TIME FROM ... TO ...", () => {
    const q = db.selectFrom("users").forSystemTime({
      kind: "from_to",
      start: lit("2024-01-01"),
      end: lit("2024-12-31"),
    })
    const r = q.compile(p)
    expect(r.sql).toContain("FOR SYSTEM_TIME FROM")
    expect(r.sql).toContain("TO")
  })

  it("FOR SYSTEM_TIME BETWEEN ... AND ...", () => {
    const q = db.selectFrom("users").forSystemTime({
      kind: "between",
      start: lit("2024-01-01"),
      end: lit("2024-12-31"),
    })
    const r = q.compile(p)
    expect(r.sql).toContain("FOR SYSTEM_TIME BETWEEN")
    expect(r.sql).toContain("AND")
  })

  it("FOR SYSTEM_TIME CONTAINED IN (...)", () => {
    const q = db.selectFrom("users").forSystemTime({
      kind: "contained_in",
      start: lit("2024-01-01"),
      end: lit("2024-12-31"),
    })
    const r = q.compile(p)
    expect(r.sql).toContain("FOR SYSTEM_TIME CONTAINED IN")
  })

  it("FOR SYSTEM_TIME ALL", () => {
    const q = db.selectFrom("users").forSystemTime({ kind: "all" })
    const r = q.compile(p)
    expect(r.sql).toContain("FOR SYSTEM_TIME ALL")
  })

  it("works with MSSQL dialect", () => {
    const mdb = sumak({
      dialect: mssqlDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
    })
    const q = mdb
      .selectFrom("users")
      .forSystemTime({ kind: "as_of", timestamp: param(0, "2024-01-01") })
    const r = q.compile(mdb.printer())
    expect(r.sql).toContain("[users]")
    expect(r.sql).toContain("FOR SYSTEM_TIME AS OF")
    expect(r.sql).toContain("@p0")
  })

  it("temporal query with WHERE", () => {
    const q = db
      .selectFrom("users")
      .forSystemTime({ kind: "as_of", timestamp: lit("2024-01-01") })
      .where(({ id }) => id.eq(1))
    const r = q.compile(p)
    expect(r.sql).toContain("FOR SYSTEM_TIME AS OF")
    expect(r.sql).toContain("WHERE")
  })
})
