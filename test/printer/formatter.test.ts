import { describe, expect, it } from "vitest"
import { formatSQL } from "../../src/printer/formatter.ts"

describe("formatSQL", () => {
  it("formats simple SELECT", () => {
    const result = formatSQL('SELECT "id", "name" FROM "users"')
    expect(result).toContain("SELECT")
    expect(result).toContain("FROM")
    expect(result.split("\n").length).toBeGreaterThanOrEqual(2)
  })

  it("formats SELECT with WHERE", () => {
    const result = formatSQL('SELECT "id" FROM "users" WHERE "id" = 1')
    expect(result).toContain("WHERE")
  })

  it("formats SELECT with JOIN", () => {
    const result = formatSQL(
      'SELECT * FROM "users" INNER JOIN "posts" ON "users"."id" = "posts"."user_id"',
    )
    expect(result).toContain("JOIN")
  })

  it("formats INSERT", () => {
    const result = formatSQL('INSERT INTO "users" ("name") VALUES ($1)')
    expect(result).toContain("INSERT INTO")
    expect(result).toContain("VALUES")
  })

  it("formats UPDATE", () => {
    const result = formatSQL('UPDATE "users" SET "name" = $1 WHERE "id" = $2')
    expect(result).toContain("UPDATE")
    expect(result).toContain("SET")
    expect(result).toContain("WHERE")
  })

  it("formats DELETE", () => {
    const result = formatSQL('DELETE FROM "users" WHERE "id" = $1')
    expect(result).toContain("DELETE FROM")
    expect(result).toContain("WHERE")
  })

  it("handles empty input", () => {
    expect(formatSQL("")).toBe("")
  })

  it("preserves string literals", () => {
    const result = formatSQL("SELECT 'hello world' FROM dual")
    expect(result).toContain("'hello world'")
  })

  it("formats WITH clause", () => {
    const result = formatSQL(
      'WITH "active" AS (SELECT * FROM "users" WHERE "active" = TRUE) SELECT * FROM "active"',
    )
    expect(result).toContain("WITH")
  })

  it("formats ORDER BY", () => {
    const result = formatSQL('SELECT * FROM "users" ORDER BY "name" ASC')
    expect(result).toContain("ORDER BY")
  })

  it("formats GROUP BY and HAVING", () => {
    const result = formatSQL(
      'SELECT "status", COUNT(*) FROM "users" GROUP BY "status" HAVING COUNT(*) > 5',
    )
    expect(result).toContain("GROUP BY")
    expect(result).toContain("HAVING")
  })
})
