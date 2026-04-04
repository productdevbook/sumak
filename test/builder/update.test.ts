import { describe, expect, it } from "vitest"
import { update } from "../../src/builder/update.ts"
import { col, eq, lit, star } from "../../src/ast/expression.ts"
import { param } from "../../src/ast/expression.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { MysqlPrinter } from "../../src/printer/mysql.ts"
import { SqlitePrinter } from "../../src/printer/sqlite.ts"

const pg = new PgPrinter()
const mysql = new MysqlPrinter()
const sqlite = new SqlitePrinter()

describe("UpdateBuilder", () => {
  it("builds UPDATE with SET and WHERE (pg)", () => {
    const node = update("users")
      .set("name", param(0, "Alice"))
      .where(eq(col("id"), param(1, 1)))
      .build()
    const result = pg.print(node)
    expect(result.sql).toBe('UPDATE "users" SET "name" = $1 WHERE ("id" = $2)')
    expect(result.params).toEqual(["Alice", 1])
  })

  it("builds UPDATE with SET and WHERE (mysql)", () => {
    const node = update("users")
      .set("name", param(0, "Alice"))
      .where(eq(col("id"), param(1, 1)))
      .build()
    const result = mysql.print(node)
    expect(result.sql).toBe("UPDATE `users` SET `name` = ? WHERE (`id` = ?)")
    expect(result.params).toEqual(["Alice", 1])
  })

  it("builds UPDATE with SET and WHERE (sqlite)", () => {
    const node = update("users")
      .set("name", param(0, "Alice"))
      .where(eq(col("id"), param(1, 1)))
      .build()
    const result = sqlite.print(node)
    expect(result.sql).toBe('UPDATE "users" SET "name" = ? WHERE ("id" = ?)')
  })

  it("builds UPDATE with multiple SET", () => {
    const node = update("users")
      .set("name", param(0, "Alice"))
      .set("email", param(1, "alice@example.com"))
      .where(eq(col("id"), param(2, 1)))
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain('"name" = $1')
    expect(result.sql).toContain('"email" = $2')
  })

  it("builds UPDATE with RETURNING", () => {
    const node = update("users").set("name", param(0, "Alice")).returning(star()).build()
    const result = pg.print(node)
    expect(result.sql).toContain("RETURNING *")
  })

  it("builds UPDATE with FROM", () => {
    const node = update("users")
      .set("name", col("p.name"))
      .from("profiles")
      .where(eq(col("users.id"), col("profiles.user_id")))
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("FROM")
  })

  it("is immutable", () => {
    const b1 = update("users")
    const b2 = b1.set("name", lit("Alice"))
    const b3 = b1.set("name", lit("Bob"))

    expect(pg.print(b2.build()).sql).toContain("'Alice'")
    expect(pg.print(b3.build()).sql).toContain("'Bob'")
  })
})
