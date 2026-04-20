import { describe, expect, it } from "vitest"

import { col, eq, param } from "../../src/ast/expression.ts"
import { star } from "../../src/ast/expression.ts"
import { insert } from "../../src/builder/insert.ts"
import { select } from "../../src/builder/select.ts"
import { UpdateBuilder } from "../../src/builder/update.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { MysqlPrinter } from "../../src/printer/mysql.ts"

describe("MysqlPrinter", () => {
  const printer = new MysqlPrinter()

  it("uses ? parameter style", () => {
    const node = select("id")
      .from("users")
      .where(eq(col("id"), param(0, 42)))
      .build()
    const result = printer.print(node)
    expect(result.sql).toContain("?")
    expect(result.sql).not.toContain("$")
    expect(result.params).toEqual([42])
  })

  it("uses backtick identifiers", () => {
    const node = select("name").from("users").build()
    const result = printer.print(node)
    expect(result.sql).toContain("`name`")
    expect(result.sql).toContain("`users`")
  })

  it("escapes backticks in identifiers", () => {
    const node = select("col`name").from("users").build()
    const result = printer.print(node)
    expect(result.sql).toContain("`col``name`")
  })

  it("throws on RETURNING in INSERT", () => {
    const node = insert("users").columns("name").values("Alice").returning(star()).build()
    expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
  })

  it("handles FOR UPDATE", () => {
    const node = select("id").from("users").forUpdate().build()
    const result = printer.print(node)
    expect(result.sql).toContain("FOR UPDATE")
  })

  it("UPDATE ... JOIN (multi-table) puts JOIN right after the target — no FROM", () => {
    const node = new UpdateBuilder()
      .table("users")
      .innerJoin("orders", eq(col("id"), col("user_id")))
      .set("name", param(0, "Bob"))
      .where(eq(col("id"), param(1, 1)))
      .build()
    const r = printer.print(node)
    expect(r.sql).toContain("UPDATE")
    expect(r.sql).toContain("INNER JOIN")
    expect(r.sql).toContain("SET")
    expect(r.sql).not.toContain("FROM")
    const joinIdx = r.sql.indexOf("INNER JOIN")
    const setIdx = r.sql.indexOf("SET")
    expect(joinIdx).toBeLessThan(setIdx)
  })

  it("UPDATE ... FROM is rejected on MySQL with a helpful error", () => {
    const node = new UpdateBuilder()
      .table("users")
      .from("orders")
      .set("name", param(0, "Bob"))
      .build()
    expect(() => printer.print(node)).toThrow(UnsupportedDialectFeatureError)
  })
})
