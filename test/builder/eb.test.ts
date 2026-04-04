import { describe, expect, it } from "vitest"

import {
  and,
  avg,
  case_,
  cast,
  coalesce,
  count,
  exists,
  jsonRef,
  max,
  min,
  not,
  notExists,
  or,
  sum,
  val,
} from "../../src/builder/eb.ts"
import { select } from "../../src/builder/select.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text, integer, boolean, jsonb } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer(),
      active: boolean().defaultTo(true),
      meta: jsonb(),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      userId: integer(),
    },
  },
})

const p = db.printer()

describe("Clean callback API", () => {
  describe("where callback", () => {
    it("simple eq", () => {
      const q = db.selectFrom("users").where(({ id }) => id.eq(42))
      const r = q.compile(p)
      expect(r.sql).toBe('SELECT * FROM "users" WHERE ("id" = $1)')
      expect(r.params).toEqual([42])
    })

    it("string like", () => {
      const q = db.selectFrom("users").where(({ name }) => name.like("%ali%"))
      expect(q.compile(p).sql).toContain("LIKE")
    })

    it("gt comparison", () => {
      const q = db.selectFrom("users").where(({ age }) => age.gt(18))
      const r = q.compile(p)
      expect(r.sql).toContain(">")
      expect(r.params).toEqual([18])
    })

    it("in list", () => {
      const q = db.selectFrom("users").where(({ id }) => id.in([1, 2, 3]))
      const r = q.compile(p)
      expect(r.sql).toContain("IN")
      expect(r.params).toEqual([1, 2, 3])
    })

    it("isNull", () => {
      const q = db.selectFrom("users").where(({ age }) => age.isNull())
      expect(q.compile(p).sql).toContain("IS NULL")
    })

    it("isNotNull", () => {
      const q = db.selectFrom("users").where(({ email }) => email.isNotNull())
      expect(q.compile(p).sql).toContain("IS NOT NULL")
    })

    it("between", () => {
      const q = db.selectFrom("users").where(({ age }) => age.between(18, 65))
      const r = q.compile(p)
      expect(r.sql).toContain("BETWEEN")
      expect(r.params).toEqual([18, 65])
    })

    it("notIn", () => {
      const q = db.selectFrom("users").where(({ id }) => id.notIn([99, 100]))
      expect(q.compile(p).sql).toContain("NOT IN")
    })

    it("and combinator", () => {
      const q = db.selectFrom("users").where(({ age, active }) => and(age.gt(18), active.eq(true)))
      const r = q.compile(p)
      expect(r.sql).toContain("AND")
      expect(r.params).toEqual([18, true])
    })

    it("or combinator", () => {
      const q = db
        .selectFrom("users")
        .where(({ name, email }) => or(name.like("%alice%"), email.like("%alice%")))
      expect(q.compile(p).sql).toContain("OR")
    })

    it("neq", () => {
      const q = db.selectFrom("users").where(({ active }) => active.neq(false))
      expect(q.compile(p).sql).toContain("!=")
    })

    it("gte / lte", () => {
      const q1 = db.selectFrom("users").where(({ age }) => age.gte(18))
      expect(q1.compile(p).sql).toContain(">=")

      const q2 = db.selectFrom("users").where(({ age }) => age.lte(65))
      expect(q2.compile(p).sql).toContain("<=")
    })
  })

  describe("join callback", () => {
    it("innerJoin with table-qualified columns", () => {
      const q = db
        .selectFrom("users")
        .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
      const r = q.compile(p)
      expect(r.sql).toContain("INNER JOIN")
      expect(r.sql).toContain('"users"."id"')
      expect(r.sql).toContain('"posts"."userId"')
    })

    it("leftJoin with callback", () => {
      const q = db
        .selectFrom("users")
        .leftJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
      expect(q.compile(p).sql).toContain("LEFT JOIN")
    })
  })

  describe("update where callback", () => {
    it("update with callback where", () => {
      const q = db
        .update("users")
        .set({ name: "Bob" })
        .where(({ id }) => id.eq(1))
      const r = q.compile(p)
      expect(r.sql).toContain("UPDATE")
      expect(r.sql).toContain("WHERE")
    })
  })

  describe("delete where callback", () => {
    it("delete with callback where", () => {
      const q = db.deleteFrom("users").where(({ id }) => id.eq(1))
      const r = q.compile(p)
      expect(r.sql).toContain("DELETE FROM")
      expect(r.sql).toContain("WHERE")
    })
  })

  describe("select + where chain", () => {
    it("full query with callback API", () => {
      const q = db
        .selectFrom("users")
        .select("id", "name", "email")
        .where(({ age, active }) => and(age.gte(18), active.eq(true)))
        .orderBy("name")
        .limit(10)
      const r = q.compile(p)
      expect(r.sql).toContain("SELECT")
      expect(r.sql).toContain("WHERE")
      expect(r.sql).toContain("ORDER BY")
      expect(r.sql).toContain("LIMIT")
      expect(r.params).toEqual([18, true])
    })
  })

  describe("aggregate functions", () => {
    it("count()", () => {
      const q = db.selectFrom("users").selectExpr(count(), "total")
      const r = q.compile(p)
      expect(r.sql).toContain("COUNT(*)")
    })

    it("sum()", () => {
      const q = db.selectFrom("users").selectExpr(sum(val(1) as any), "s")
      const r = q.compile(p)
      expect(r.sql).toContain("SUM(")
    })

    it("avg()", () => {
      const q = db.selectFrom("users").selectExpr(avg(val(1) as any), "a")
      const r = q.compile(p)
      expect(r.sql).toContain("AVG(")
    })

    it("min()", () => {
      const q = db.selectFrom("users").selectExpr(min(val(1) as any), "m")
      const r = q.compile(p)
      expect(r.sql).toContain("MIN(")
    })

    it("max()", () => {
      const q = db.selectFrom("users").selectExpr(max(val(1) as any), "m")
      const r = q.compile(p)
      expect(r.sql).toContain("MAX(")
    })

    it("coalesce()", () => {
      const q = db.selectFrom("users").selectExpr(coalesce(val(null) as any, val(0) as any), "c")
      const r = q.compile(p)
      expect(r.sql).toContain("COALESCE(")
    })
  })

  describe("not()", () => {
    it("NOT expression", () => {
      const q = db.selectFrom("users").where(({ active }) => not(active.eq(true)))
      const r = q.compile(p)
      expect(r.sql).toContain("NOT")
    })
  })

  describe("exists / notExists", () => {
    it("EXISTS subquery", () => {
      const sub = select("id").from("posts").where({ type: "literal", value: true }).build()
      const q = db.selectFrom("users").where(() => exists(sub))
      const r = q.compile(p)
      expect(r.sql).toContain("EXISTS")
      expect(r.sql).toContain("SELECT")
    })

    it("NOT EXISTS subquery", () => {
      const sub = select("id").from("posts").where({ type: "literal", value: true }).build()
      const q = db.selectFrom("users").where(() => notExists(sub))
      const r = q.compile(p)
      expect(r.sql).toContain("NOT EXISTS")
    })
  })

  describe("cast()", () => {
    it("CAST expression", () => {
      const q = db.selectFrom("users").selectExpr(cast(val(42), "text"), "t")
      const r = q.compile(p)
      expect(r.sql).toContain("CAST(")
      expect(r.sql).toContain("AS text")
    })
  })

  describe("jsonRef()", () => {
    it("-> operator", () => {
      const q = db.selectFrom("users").selectExpr(jsonRef(val(null) as any, "name", "->"), "j")
      const r = q.compile(p)
      expect(r.sql).toContain("->")
    })

    it("->> operator", () => {
      const q = db.selectFrom("users").selectExpr(jsonRef(val(null) as any, "name", "->>"), "j")
      const r = q.compile(p)
      expect(r.sql).toContain("->>")
    })
  })

  describe("case_()", () => {
    it("simple CASE WHEN THEN ELSE END", () => {
      const q = db.selectFrom("users").selectExpr(
        case_()
          .when(val(true) as any, val(1))
          .else_(val(0))
          .end(),
        "result",
      )
      const r = q.compile(p)
      expect(r.sql).toContain("CASE")
      expect(r.sql).toContain("WHEN")
      expect(r.sql).toContain("THEN")
      expect(r.sql).toContain("ELSE")
      expect(r.sql).toContain("END")
    })

    it("CASE with multiple WHEN clauses", () => {
      const q = db.selectFrom("users").selectExpr(
        case_()
          .when(val(true) as any, val("a"))
          .when(val(false) as any, val("b"))
          .end(),
        "result",
      )
      const r = q.compile(p)
      const whenCount = (r.sql.match(/WHEN/g) || []).length
      expect(whenCount).toBe(2)
    })
  })
})
