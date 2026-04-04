import { describe, expect, it } from "vitest"

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

describe("$if() conditional query building", () => {
  it("applies transformation when condition is true", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .$if(true, (qb) => qb.where(({ age }) => age.gt(18)))
      .compile(p)
    expect(q.sql).toContain("WHERE")
  })

  it("skips transformation when condition is false", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .$if(false, (qb) => qb.where(({ age }) => age.gt(18)))
      .compile(p)
    expect(q.sql).not.toContain("WHERE")
  })

  it("chains multiple $if calls", () => {
    const withFilter = true
    const withOrder = false

    const q = db
      .selectFrom("users")
      .select("id", "name")
      .$if(withFilter, (qb) => qb.where(({ age }) => age.gt(18)))
      .$if(withOrder, (qb) => qb.orderBy("name"))
      .compile(p)
    expect(q.sql).toContain("WHERE")
    expect(q.sql).not.toContain("ORDER BY")
  })

  it("works on TypedInsertBuilder", () => {
    const withConflict = true
    const q = db
      .insertInto("users")
      .values({ name: "Alice", age: 30 })
      .$if(withConflict, (qb) => qb.onConflictDoNothing("id"))
      .compile(p)
    expect(q.sql).toContain("ON CONFLICT")
  })

  it("works on TypedUpdateBuilder", () => {
    const addFilter = true
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .$if(addFilter, (qb) => qb.where(({ age }) => age.gt(0)))
      .compile(p)
    expect(q.sql).toContain("AND")
  })

  it("works on TypedDeleteBuilder", () => {
    const softFilter = false
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .$if(softFilter, (qb) => qb.where(({ age }) => age.gt(0)))
      .compile(p)
    expect(q.sql).not.toContain("AND")
  })
})
