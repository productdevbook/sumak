import { describe, expect, it } from "vitest"

import { col, star } from "../../src/ast/expression.ts"
import { insert } from "../../src/builder/insert.ts"
import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { MysqlPrinter } from "../../src/printer/mysql.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { SqlitePrinter } from "../../src/printer/sqlite.ts"

const pg = new PgPrinter()
const mysql = new MysqlPrinter()
const sqlite = new SqlitePrinter()

describe("InsertBuilder", () => {
  it("builds INSERT with values (pg)", () => {
    const node = insert("users")
      .columns("name", "email")
      .values("Alice", "alice@example.com")
      .build()
    const result = pg.print(node)
    expect(result.sql).toBe('INSERT INTO "users" ("name", "email") VALUES ($1, $2)')
    expect(result.params).toEqual(["Alice", "alice@example.com"])
  })

  it("builds INSERT with values (mysql)", () => {
    const node = insert("users")
      .columns("name", "email")
      .values("Alice", "alice@example.com")
      .build()
    const result = mysql.print(node)
    expect(result.sql).toBe("INSERT INTO `users` (`name`, `email`) VALUES (?, ?)")
    expect(result.params).toEqual(["Alice", "alice@example.com"])
  })

  it("builds INSERT with values (sqlite)", () => {
    const node = insert("users").columns("name").values("Alice").build()
    const result = sqlite.print(node)
    expect(result.sql).toBe('INSERT INTO "users" ("name") VALUES (?)')
    expect(result.params).toEqual(["Alice"])
  })

  it("builds INSERT with multiple rows", () => {
    const node = insert("users").columns("name").values("Alice").values("Bob").build()
    const result = pg.print(node)
    expect(result.sql).toBe('INSERT INTO "users" ("name") VALUES ($1), ($2)')
    expect(result.params).toEqual(["Alice", "Bob"])
  })

  it("builds INSERT with RETURNING (pg)", () => {
    const node = insert("users").columns("name").values("Alice").returning(star()).build()
    const result = pg.print(node)
    expect(result.sql).toContain("RETURNING *")
  })

  it("throws for RETURNING in mysql", () => {
    const node = insert("users").columns("name").values("Alice").returning(star()).build()
    expect(() => mysql.print(node)).toThrow(UnsupportedDialectFeatureError)
  })

  it("builds INSERT with ON CONFLICT DO NOTHING", () => {
    const node = insert("users")
      .columns("email")
      .values("alice@example.com")
      .onConflictDoNothing("email")
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("ON CONFLICT")
    expect(result.sql).toContain("DO NOTHING")
  })

  it("builds INSERT with ON CONFLICT DO UPDATE", () => {
    const node = insert("users")
      .columns("email", "name")
      .values("alice@example.com", "Alice")
      .onConflictDoUpdate(["email"], [{ column: "name", value: col("EXCLUDED.name") }])
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("ON CONFLICT")
    expect(result.sql).toContain("DO UPDATE SET")
  })

  it("is immutable", () => {
    const b1 = insert("users").columns("name")
    const b2 = b1.values("Alice")
    const b3 = b1.values("Bob")

    expect(pg.print(b2.build()).params).toEqual(["Alice"])
    expect(pg.print(b3.build()).params).toEqual(["Bob"])
  })
})
