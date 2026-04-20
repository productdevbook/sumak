import { describe, expect, it } from "vitest"

import { Col } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("orWhere()", () => {
  it("first orWhere acts as regular where", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .orWhere(({ name }) => name.eq("Alice"))
      .compile(p)
    expect(q.sql).toContain("WHERE")
    expect(q.sql).not.toContain("OR")
  })

  it("orWhere after where produces OR", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ name }) => name.eq("Alice"))
      .orWhere(({ name }) => name.eq("Bob"))
      .compile(p)
    expect(q.sql).toContain("OR")
  })

  it("mixed where + orWhere + where", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ name }) => name.eq("Alice"))
      .orWhere(({ name }) => name.eq("Bob"))
      .where(({ age }) => age.gt(18))
      .compile(p)
    // (name = Alice OR name = Bob) AND age > 18
    expect(q.sql).toContain("OR")
    expect(q.sql).toContain("AND")
  })
})

describe("Col.cast()", () => {
  it("inline CAST on column", () => {
    const col = new Col<number>("age")
    const q = db
      .selectFrom("users")
      .select({ ageText: col.cast<string>("text") })
      .compile(p)
    expect(q.sql).toContain("CAST(")
    expect(q.sql).toContain("AS text")
  })
})

describe("TRUNCATE TABLE", () => {
  it("basic TRUNCATE", () => {
    const node = db.schema.truncateTable("users").build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("TRUNCATE TABLE")
    expect(q.sql).toContain('"users"')
  })

  it("TRUNCATE with CASCADE", () => {
    const node = db.schema.truncateTable("users").cascade().build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("CASCADE")
  })

  it("TRUNCATE with RESTART IDENTITY", () => {
    const node = db.schema.truncateTable("users").restartIdentity().build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("RESTART IDENTITY")
  })

  it("TRUNCATE with RESTART IDENTITY CASCADE", () => {
    const node = db.schema.truncateTable("users").restartIdentity().cascade().build()
    const q = db.compileDDL(node)
    expect(q.sql).toContain("RESTART IDENTITY")
    expect(q.sql).toContain("CASCADE")
  })
})
