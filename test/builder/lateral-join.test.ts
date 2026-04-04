import { describe, expect, it } from "vitest"

import { col, eq, lit, subquery } from "../../src/ast/expression.ts"
import { SelectBuilder } from "../../src/builder/select.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("Lateral JOIN", () => {
  it("INNER JOIN LATERAL (untyped)", () => {
    const sub = new SelectBuilder().columns("id").from("posts").build()
    const subNode = { type: "subquery" as const, query: sub, alias: "p" }
    const q = new SelectBuilder()
      .allColumns()
      .from("users")
      .innerJoinLateral(subNode, eq(col("id", "users"), col("user_id", "p")))
      .build()
    expect(q.joins).toHaveLength(1)
    expect(q.joins[0]!.lateral).toBe(true)
    expect(q.joins[0]!.joinType).toBe("INNER")
  })

  it("LEFT JOIN LATERAL (untyped)", () => {
    const sub = new SelectBuilder().columns("id").from("posts").build()
    const subNode = { type: "subquery" as const, query: sub, alias: "p" }
    const q = new SelectBuilder()
      .allColumns()
      .from("users")
      .leftJoinLateral(subNode, eq(col("id", "users"), col("user_id", "p")))
      .build()
    expect(q.joins[0]!.lateral).toBe(true)
    expect(q.joins[0]!.joinType).toBe("LEFT")
  })

  it("PG prints INNER JOIN LATERAL", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
        posts: { id: serial().primaryKey(), user_id: integer(), title: text().notNull() },
      },
    })
    const sub = new SelectBuilder().columns("id", "title").from("posts").build()
    const subNode = { type: "subquery" as const, query: sub, alias: "p" }
    const node = new SelectBuilder()
      .allColumns()
      .from("users")
      .innerJoinLateral(subNode, eq(col("id", "users"), col("user_id", "p")))
      .build()
    const q = db.printer().print(node)
    expect(q.sql).toContain("INNER JOIN LATERAL")
    expect(q.sql).toContain("AS")
    expect(q.sql).toContain("ON")
  })

  it("MySQL prints LEFT JOIN LATERAL", () => {
    const db = sumak({
      dialect: mysqlDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const sub = new SelectBuilder().columns("id").from("posts").build()
    const subNode = { type: "subquery" as const, query: sub, alias: "p" }
    const node = new SelectBuilder()
      .allColumns()
      .from("users")
      .leftJoinLateral(subNode, lit(true))
      .build()
    const q = db.printer().print(node)
    expect(q.sql).toContain("LEFT JOIN LATERAL")
  })

  it("regular JOIN does not have LATERAL", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
        posts: { id: serial().primaryKey(), user_id: integer() },
      },
    })
    const node = new SelectBuilder()
      .allColumns()
      .from("users")
      .innerJoin("posts", eq(col("id", "users"), col("user_id", "posts")))
      .build()
    const q = db.printer().print(node)
    expect(q.sql).toContain("INNER JOIN")
    expect(q.sql).not.toContain("LATERAL")
  })
})
