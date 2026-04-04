import { describe, expect, it } from "vitest"

import { Col } from "../../src/builder/eb.ts"
import { SelectBuilder } from "../../src/builder/select.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("Typed DELETE with USING", () => {
  const db = sumak({
    dialect: pgDialect(),
    tables: {
      orders: { id: serial().primaryKey(), user_id: integer().notNull() },
      users: { id: serial().primaryKey(), name: text().notNull() },
    },
  })

  it("typed using()", () => {
    const orderId = new Col<number>("id", "orders")
    const userId = new Col<number>("id", "users")
    const q = db
      .deleteFrom("orders")
      .using("users")
      .where(() => orderId.eqCol(userId))
      .compile(db.printer())
    expect(q.sql).toContain("USING")
    expect(q.sql).toContain("WHERE")
  })
})

describe("Typed DELETE with JOIN", () => {
  const db = sumak({
    dialect: mysqlDialect(),
    tables: {
      orders: { id: serial().primaryKey(), user_id: integer().notNull() },
      users: { id: serial().primaryKey(), name: text().notNull() },
    },
  })

  it("typed innerJoin()", () => {
    const orderId = new Col<number>("user_id", "orders")
    const userId = new Col<number>("id", "users")
    const q = db
      .deleteFrom("orders")
      .innerJoin("users", orderId.eqCol(userId))
      .where(({ id }) => id.eq(1))
      .compile(db.printer())
    expect(q.sql).toContain("INNER JOIN")
  })
})

describe("Typed UPDATE with JOIN", () => {
  const db = sumak({
    dialect: mysqlDialect(),
    tables: {
      orders: { id: serial().primaryKey(), total: integer(), user_id: integer().notNull() },
      users: { id: serial().primaryKey(), name: text().notNull() },
    },
  })

  it("typed innerJoin()", () => {
    const orderId = new Col<number>("user_id", "orders")
    const userId = new Col<number>("id", "users")
    const q = db
      .update("orders")
      .set({ total: 0 })
      .innerJoin("users", orderId.eqCol(userId))
      .compile(db.printer())
    expect(q.sql).toContain("INNER JOIN")
  })

  it("typed leftJoin()", () => {
    const orderId = new Col<number>("user_id", "orders")
    const userId = new Col<number>("id", "users")
    const q = db
      .update("orders")
      .set({ total: 0 })
      .leftJoin("users", orderId.eqCol(userId))
      .compile(db.printer())
    expect(q.sql).toContain("LEFT JOIN")
  })
})

describe("CROSS JOIN LATERAL", () => {
  const db = sumak({
    dialect: pgDialect(),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull() },
    },
  })

  it("untyped crossJoinLateral", () => {
    const sub = new SelectBuilder().columns("id").from("posts").build()
    const subNode = { type: "subquery" as const, query: sub, alias: "p" }
    const node = new SelectBuilder().allColumns().from("users").crossJoinLateral(subNode).build()
    expect(node.joins[0]!.lateral).toBe(true)
    expect(node.joins[0]!.joinType).toBe("CROSS")
  })

  it("prints CROSS JOIN LATERAL", () => {
    const sub = new SelectBuilder().columns("id").from("posts").build()
    const subNode = { type: "subquery" as const, query: sub, alias: "p" }
    const node = new SelectBuilder().allColumns().from("users").crossJoinLateral(subNode).build()
    const q = db.printer().print(node)
    expect(q.sql).toContain("CROSS JOIN LATERAL")
  })
})
