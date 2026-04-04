import { describe, expect, it } from "vitest"

import { SelectBuilder } from "../../src/builder/select.ts"
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

const p = db.printer()

describe("Subquery in FROM (derived tables)", () => {
  it("untyped: subquery as FROM source", () => {
    const sub = new SelectBuilder().columns("id", "name").from("users").build()
    const subNode = { type: "subquery" as const, query: sub, alias: "u" }
    const q = new SelectBuilder().allColumns().from(subNode).build()
    expect(q.from).toBeDefined()
    expect(q.from!.type).toBe("subquery")
  })

  it("typed: selectFromSubquery", () => {
    const sub = db.selectFrom("users").select("id", "name")
    const q = db.selectFromSubquery(sub, "u").selectAll().compile(p)
    expect(q.sql).toContain("SELECT *")
    expect(q.sql).toContain("FROM (SELECT")
    expect(q.sql).toContain(') AS "u"')
  })

  it("derived table with WHERE", () => {
    const sub = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ age }) => age.gt(18))
    const q = db.selectFromSubquery(sub, "adults").selectAll().compile(p)
    expect(q.sql).toContain("FROM (SELECT")
    expect(q.sql).toContain("WHERE")
    expect(q.sql).toContain(') AS "adults"')
  })

  it("nested derived tables", () => {
    const inner = new SelectBuilder().columns("id").from("users").build()
    const innerSub = { type: "subquery" as const, query: inner, alias: "i" }
    const outer = new SelectBuilder().allColumns().from(innerSub).build()
    const outerSub = { type: "subquery" as const, query: outer, alias: "o" }
    const q = new SelectBuilder().allColumns().from(outerSub).build()
    expect(q.from!.type).toBe("subquery")
    const printed = db.printer().print(q)
    expect(printed.sql).toContain("FROM (SELECT * FROM (SELECT")
  })
})
