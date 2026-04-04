import { describe, expect, it } from "vitest"
import { deleteFrom } from "../../src/builder/delete.ts"
import { col, eq, lit, param, star } from "../../src/ast/expression.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { MysqlPrinter } from "../../src/printer/mysql.ts"
import { SqlitePrinter } from "../../src/printer/sqlite.ts"

const pg = new PgPrinter()
const mysql = new MysqlPrinter()
const sqlite = new SqlitePrinter()

describe("DeleteBuilder", () => {
  it("builds DELETE with WHERE (pg)", () => {
    const node = deleteFrom("users")
      .where(eq(col("id"), param(0, 1)))
      .build()
    const result = pg.print(node)
    expect(result.sql).toBe('DELETE FROM "users" WHERE ("id" = $1)')
    expect(result.params).toEqual([1])
  })

  it("builds DELETE with WHERE (mysql)", () => {
    const node = deleteFrom("users")
      .where(eq(col("id"), param(0, 1)))
      .build()
    const result = mysql.print(node)
    expect(result.sql).toBe("DELETE FROM `users` WHERE (`id` = ?)")
  })

  it("builds DELETE with WHERE (sqlite)", () => {
    const node = deleteFrom("users")
      .where(eq(col("id"), param(0, 1)))
      .build()
    const result = sqlite.print(node)
    expect(result.sql).toBe('DELETE FROM "users" WHERE ("id" = ?)')
  })

  it("builds DELETE without WHERE", () => {
    const node = deleteFrom("users").build()
    expect(pg.print(node).sql).toBe('DELETE FROM "users"')
  })

  it("builds DELETE with RETURNING", () => {
    const node = deleteFrom("users")
      .where(eq(col("active"), lit(false)))
      .returning(star())
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("RETURNING *")
  })

  it("is immutable", () => {
    const b1 = deleteFrom("users")
    const b2 = b1.where(eq(col("id"), lit(1)))
    const b3 = b1.where(eq(col("id"), lit(2)))

    expect(pg.print(b1.build()).sql).not.toContain("WHERE")
    expect(pg.print(b2.build()).sql).toContain("1")
    expect(pg.print(b3.build()).sql).toContain("2")
  })
})
