import { describe, expect, it } from "vitest"

import { Col, subqueryExpr, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    employees: {
      id: serial().primaryKey(),
      name: text().notNull(),
      managerId: integer(),
    },
  },
})

const p = db.printer()

describe("Self-join with alias", () => {
  it("innerJoinAs for self-join", () => {
    const q = db
      .selectFrom("employees")
      .innerJoinAs("employees", "mgr", ({ employees, mgr }) => employees.managerId.eq(mgr.id))
      .selectAll()
      .compile(p)
    expect(q.sql).toContain("INNER JOIN")
    expect(q.sql).toContain('"employees"')
    expect(q.sql).toContain('AS "mgr"')
    expect(q.sql).toContain('"employees"."managerId"')
    expect(q.sql).toContain('"mgr"."id"')
  })

  it("leftJoinAs for optional self-join", () => {
    const q = db
      .selectFrom("employees")
      .leftJoinAs("employees", "mgr", ({ employees, mgr }) => employees.managerId.eq(mgr.id))
      .selectAll()
      .compile(p)
    expect(q.sql).toContain("LEFT JOIN")
    expect(q.sql).toContain('AS "mgr"')
  })
})

describe("subqueryExpr — scalar subquery in expressions", () => {
  it("SET col = (SELECT ...)", () => {
    const sub = db.selectFrom("employees").select("name").build()
    const q = db
      .update("employees")
      .set({ name: subqueryExpr(sub) })
      .where(({ id }) => id.eq(1))
      .compile(p)
    expect(q.sql).toContain("SET")
    expect(q.sql).toContain("(SELECT")
  })

  it("scalar subquery in selectExpr", () => {
    const sub = db.selectFrom("employees").select("name").build()
    const q = db
      .selectFrom("employees")
      .select({ sub_name: subqueryExpr(sub) })
      .compile(p)
    expect(q.sql).toContain("(SELECT")
    expect(q.sql).toContain('"sub_name"')
  })
})

describe("Col.asc() / Col.desc()", () => {
  it("asc() returns order spec", () => {
    const col = new Col<number>("id")
    const spec = col.asc()
    expect(spec.direction).toBe("ASC")
  })

  it("desc() returns order spec", () => {
    const col = new Col<number>("id")
    const spec = col.desc()
    expect(spec.direction).toBe("DESC")
  })
})

describe("RETURNING with expression", () => {
  it("returningExpr on INSERT", () => {
    const q = db
      .insertInto("employees")
      .values({ name: "Alice", managerId: 0 })
      .returning({ status: val("done") })
      .compile(p)
    expect(q.sql).toContain("RETURNING")
    expect(q.sql).toContain('"status"')
  })
})
