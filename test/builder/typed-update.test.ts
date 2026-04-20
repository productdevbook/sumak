import { describe, expect, it } from "vitest"

import { select } from "../../src/builder/select.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { boolean, integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      active: boolean().defaultTo(true),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      userId: integer(),
    },
  },
})

const printer = db.printer()

describe("TypedUpdateBuilder", () => {
  it("updates with SET and WHERE callback", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
    const result = q.compile(printer)
    expect(result.sql).toContain("UPDATE")
    expect(result.sql).toContain("SET")
    expect(result.sql).toContain("WHERE")
  })

  it("updates multiple columns", () => {
    const q = db.update("users").set({ name: "Bob", active: false })
    const result = q.compile(printer)
    expect(result.sql).toContain('"name"')
    expect(result.sql).toContain('"active"')
  })

  it("updates with RETURNING *", () => {
    const q = db.update("users").set({ name: "Bob" }).returningAll()
    expect(q.compile(printer).sql).toContain("RETURNING *")
  })

  it("updates with RETURNING specific columns", () => {
    const q = db.update("users").set({ name: "Bob" }).returning("id", "name")
    expect(q.compile(printer).sql).toContain("RETURNING")
  })

  it("updates with FROM clause", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .from("posts")
      .where(({ id }) => id.eq(1))
    const result = q.compile(printer)
    expect(result.sql).toContain("FROM")
    expect(result.sql).toContain('"posts"')
  })

  it("updates with CTE (WITH)", () => {
    const cteQuery = select("id").from("users").build()
    const q = db.update("users").with("target", cteQuery).set({ active: false })
    const result = q.compile(printer)
    expect(result.sql).toContain("WITH")
    expect(result.sql).toContain('"target"')
    expect(result.sql).toContain("UPDATE")
  })

  it("accepts a TypedSelectBuilder directly in .with(), no manual .build()", () => {
    const cteBuilder = db.selectFrom("users").select("id")
    const q = db.update("users").with("target", cteBuilder).set({ active: false })
    const result = q.compile(printer)
    expect(result.sql).toContain("WITH")
    expect(result.sql).toContain('"target"')
  })
})
