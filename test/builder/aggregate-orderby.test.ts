import { describe, expect, it } from "vitest"

import { aggOrderBy, arrayAgg, count, stringAgg, val } from "../../src/builder/eb.ts"
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

describe("STRING_AGG", () => {
  it("basic STRING_AGG", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(stringAgg(val("test") as any, ", "), "names")
      .compile(p)
    expect(q.sql).toContain("STRING_AGG(")
    expect(q.sql).toContain("', '")
  })

  it("STRING_AGG with ORDER BY", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(
        stringAgg(val("test") as any, ", ", [{ expr: val("test") as any, direction: "ASC" }]),
        "names",
      )
      .compile(p)
    expect(q.sql).toContain("STRING_AGG(")
    expect(q.sql).toContain("ORDER BY")
  })
})

describe("ARRAY_AGG", () => {
  it("basic ARRAY_AGG", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(arrayAgg(val(1) as any), "ids")
      .compile(p)
    expect(q.sql).toContain("ARRAY_AGG(")
  })

  it("ARRAY_AGG with ORDER BY", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(arrayAgg(val(1) as any, [{ expr: val(1) as any, direction: "DESC" }]), "ids")
      .compile(p)
    expect(q.sql).toContain("ARRAY_AGG(")
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("DESC")
  })
})

describe("aggOrderBy", () => {
  it("attach ORDER BY to existing aggregate", () => {
    const q = db
      .selectFrom("users")
      .selectExpr(aggOrderBy(count(), [{ expr: val(1) as any, direction: "DESC" }]), "cnt")
      .compile(p)
    expect(q.sql).toContain("COUNT(")
    expect(q.sql).toContain("ORDER BY")
  })
})
