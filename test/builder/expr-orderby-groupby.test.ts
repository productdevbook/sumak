import { describe, expect, it } from "vitest"

import { count, lower, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      dept: text().notNull(),
      age: integer(),
    },
  },
})

const p = db.printer()

describe("orderBy with Expression", () => {
  it("orderBy with string column (existing)", () => {
    const q = db.selectFrom("users").select("id", "name").orderBy("name").compile(p)
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain('"name"')
  })

  it("orderBy with Expression", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .orderBy(lower(val("test") as any), "DESC")
      .compile(p)
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("LOWER(")
    expect(q.sql).toContain("DESC")
  })

  it("mixed orderBy: column + expression", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .orderBy("id")
      .orderBy(lower(val("test") as any), "ASC")
      .compile(p)
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain('"id"')
    expect(q.sql).toContain("LOWER(")
  })
})

describe("groupBy with Expression", () => {
  it("groupBy with string column (existing)", () => {
    const q = db
      .selectFrom("users")
      .select("dept")
      .selectExpr(count(), "cnt")
      .groupBy("dept")
      .compile(p)
    expect(q.sql).toContain("GROUP BY")
    expect(q.sql).toContain('"dept"')
  })

  it("groupBy with Expression", () => {
    const q = db
      .selectFrom("users")
      .selectAll()
      .groupBy(lower(val("test") as any))
      .compile(p)
    expect(q.sql).toContain("GROUP BY")
    expect(q.sql).toContain("LOWER(")
  })

  it("mixed groupBy: column + expression", () => {
    const q = db
      .selectFrom("users")
      .selectAll()
      .groupBy("dept", lower(val("test") as any))
      .compile(p)
    expect(q.sql).toContain("GROUP BY")
    expect(q.sql).toContain('"dept"')
    expect(q.sql).toContain("LOWER(")
  })
})
