import { describe, expect, it } from "vitest"

import { col, eq } from "../../src/ast/expression.ts"
import { DeleteBuilder } from "../../src/builder/delete.ts"
import { UpdateBuilder } from "../../src/builder/update.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("DELETE ... USING (PG)", () => {
  it("untyped DELETE USING", () => {
    const q = new DeleteBuilder()
      .from("orders")
      .using("users")
      .where(eq(col("orders.user_id"), col("users.id")))
      .build()
    expect(q.using).toBeDefined()
    expect(q.using!.name).toBe("users")
  })

  it("DELETE USING in PG", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        orders: { id: serial().primaryKey(), user_id: integer().notNull() },
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const node = new DeleteBuilder()
      .from("orders")
      .using("users")
      .where(eq(col("user_id", "orders"), col("id", "users")))
      .build()
    const q = db.printer().print(node)
    expect(q.sql).toContain("DELETE FROM")
    expect(q.sql).toContain("USING")
    expect(q.sql).toContain("WHERE")
  })
})

describe("JOIN in DELETE (MySQL pattern)", () => {
  it("DELETE with INNER JOIN", () => {
    const db = sumak({
      dialect: mysqlDialect(),
      tables: {
        orders: { id: serial().primaryKey(), user_id: integer().notNull() },
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const node = new DeleteBuilder()
      .from("orders")
      .innerJoin("users", eq(col("user_id", "orders"), col("id", "users")))
      .where(eq(col("name", "users"), { type: "literal", value: "Alice" }))
      .build()
    const q = db.printer().print(node)
    // MySQL multi-table DELETE form: `DELETE t FROM t INNER JOIN u …`.
    // Target-table name precedes FROM — the bare `DELETE FROM t JOIN u` form
    // is a MySQL parse error.
    expect(q.sql).toMatch(/DELETE `orders` FROM `orders`/)
    expect(q.sql).toContain("INNER JOIN")
    expect(q.sql).toContain("WHERE")
  })
})

describe("JOIN in UPDATE (MySQL pattern)", () => {
  it("UPDATE with INNER JOIN", () => {
    const db = sumak({
      dialect: mysqlDialect(),
      tables: {
        orders: { id: serial().primaryKey(), total: integer(), user_id: integer().notNull() },
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const node = new UpdateBuilder()
      .table("orders")
      .set("total", { type: "literal", value: 0 })
      .innerJoin("users", eq(col("user_id", "orders"), col("id", "users")))
      .where(eq(col("name", "users"), { type: "literal", value: "Alice" }))
      .build()
    const q = db.printer().print(node)
    expect(q.sql).toContain("UPDATE")
    expect(q.sql).toContain("SET")
    expect(q.sql).toContain("INNER JOIN")
    expect(q.sql).toContain("WHERE")
  })

  it("UPDATE with LEFT JOIN", () => {
    const db = sumak({
      dialect: pgDialect(),
      tables: {
        orders: { id: serial().primaryKey(), total: integer() },
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const node = new UpdateBuilder()
      .table("orders")
      .set("total", { type: "literal", value: 0 })
      .leftJoin("users", eq(col("user_id", "orders"), col("id", "users")))
      .build()
    const q = db.printer().print(node)
    expect(q.sql).toContain("LEFT JOIN")
  })
})
