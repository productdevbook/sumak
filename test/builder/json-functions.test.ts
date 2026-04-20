import { describe, expect, it } from "vitest"

import { jsonAgg, jsonBuildObject, toJson, val } from "../../src/builder/eb.ts"
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

describe("JSON aggregate functions", () => {
  it("JSON_AGG", () => {
    const q = db
      .selectFrom("users")
      .select({ arr: jsonAgg(val("test") as any) })
      .compile(p)
    expect(q.sql).toContain("JSON_AGG(")
  })

  it("TO_JSON", () => {
    const q = db
      .selectFrom("users")
      .select({ j: toJson(val("hello") as any) })
      .compile(p)
    expect(q.sql).toContain("TO_JSON(")
  })

  it("JSON_BUILD_OBJECT", () => {
    const q = db
      .selectFrom("users")
      .select({ obj: jsonBuildObject(["name", val("Alice")], ["age", val(30) as any]) })
      .compile(p)
    expect(q.sql).toContain("JSON_BUILD_OBJECT(")
    expect(q.sql).toContain("'name'")
    expect(q.sql).toContain("'age'")
  })
})
