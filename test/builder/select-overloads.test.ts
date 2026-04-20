import { describe, expect, it } from "vitest"

import { count, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { str } from "../../src/ns/str.ts"
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

describe(".select() unified API", () => {
  it("string form — plain column names", () => {
    const q = db.selectFrom("users").select("id", "name").toSQL()
    expect(q.sql).toMatch(/SELECT "id", "name"/)
  })

  it("object form — aliased expressions", () => {
    const q = db
      .selectFrom("users")
      .select({
        total: count(),
        upperName: str.upper(val("x") as any),
      })
      .toSQL()
    expect(q.sql).toMatch(/count\(\*\) AS "total"/i)
    expect(q.sql).toMatch(/UPPER\([^)]+\) AS "upperName"/i)
  })

  it("mixed — string then object (chained)", () => {
    const q = db.selectFrom("users").select("id").select({ total: count() }).toSQL()
    expect(q.sql).toMatch(/"id",.*count\(\*\) AS "total"/i)
  })

  it("legacy selectExpr still works and delegates to new .select()", () => {
    const q = db.selectFrom("users").selectExpr(count(), "total").toSQL()
    expect(q.sql).toMatch(/count\(\*\) AS "total"/i)
  })

  it("legacy selectExprs still works", () => {
    const q = db.selectFrom("users").selectExprs({ total: count() }).toSQL()
    expect(q.sql).toMatch(/count\(\*\) AS "total"/i)
  })
})

describe(".set() unified API (update)", () => {
  it("plain values are auto-parameterized", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain('SET "name" = $1')
    expect(q.params).toContain("Bob")
  })

  it("Expression values are inlined as SQL", () => {
    const q = db
      .update("users")
      .set({ name: str.upper(val("alice") as any) as any })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/SET "name" = UPPER\(/i)
  })

  it("mixed values and expressions in one .set() object", () => {
    const q = db
      .update("users")
      .set({
        name: "Bob",
        age: val(42) as any,
      })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain('SET "name" = $1')
    expect(q.sql).toMatch(/"age" = 42|"age" = \$2/)
  })

  it("legacy setExpr still works", () => {
    const q = db
      .update("users")
      .setExpr("name", val("X"))
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toMatch(/SET "name" = 'X'/)
  })
})

describe(".returning() unified API", () => {
  it("string form on insert", () => {
    const q = db.insertInto("users").values({ name: "A", age: 1 }).returning("id", "name").toSQL()
    expect(q.sql).toMatch(/RETURNING "id", "name"/)
  })

  it("object form on insert", () => {
    const q = db
      .insertInto("users")
      .values({ name: "A", age: 1 })
      .returning({ upper: count() })
      .toSQL()
    expect(q.sql).toMatch(/RETURNING count\(\*\) AS "upper"/i)
  })

  it("object form on update", () => {
    const q = db
      .update("users")
      .set({ name: "B" })
      .where(({ id }) => id.eq(1))
      .returning({ total: count() })
      .toSQL()
    expect(q.sql).toMatch(/RETURNING count\(\*\) AS "total"/i)
  })

  it("object form on delete", () => {
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .returning({ gone: count() })
      .toSQL()
    expect(q.sql).toMatch(/RETURNING count\(\*\) AS "gone"/i)
  })

  it("legacy returningExpr still works on insert", () => {
    const q = db
      .insertInto("users")
      .values({ name: "A", age: 1 })
      .returningExpr(count(), "total")
      .toSQL()
    expect(q.sql).toMatch(/RETURNING count\(\*\) AS "total"/i)
  })
})
