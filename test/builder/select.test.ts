import { describe, expect, it } from "vitest"
import { select } from "../../src/builder/select.ts"
import { col, eq, fn, lit, star } from "../../src/ast/expression.ts"
import { PgPrinter } from "../../src/printer/pg.ts"
import { MysqlPrinter } from "../../src/printer/mysql.ts"
import { SqlitePrinter } from "../../src/printer/sqlite.ts"

const pg = new PgPrinter()
const mysql = new MysqlPrinter()
const sqlite = new SqlitePrinter()

describe("SelectBuilder", () => {
  it("builds SELECT *", () => {
    const node = select().from("users").build()
    expect(pg.print(node).sql).toBe('SELECT * FROM "users"')
    expect(mysql.print(node).sql).toBe("SELECT * FROM `users`")
    expect(sqlite.print(node).sql).toBe('SELECT * FROM "users"')
  })

  it("builds SELECT with specific columns", () => {
    const node = select("id", "name").from("users").build()
    expect(pg.print(node).sql).toBe('SELECT "id", "name" FROM "users"')
  })

  it("builds SELECT DISTINCT", () => {
    const node = select("name").distinct().from("users").build()
    expect(pg.print(node).sql).toBe('SELECT DISTINCT "name" FROM "users"')
  })

  it("builds SELECT with WHERE", () => {
    const node = select("id")
      .from("users")
      .where(eq(col("id"), lit(1)))
      .build()
    expect(pg.print(node).sql).toBe('SELECT "id" FROM "users" WHERE ("id" = 1)')
  })

  it("builds SELECT with INNER JOIN", () => {
    const node = select("u.id", "p.title")
      .from("users", "u")
      .innerJoin("posts", eq(col("u.id"), col("p.user_id")), "p")
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("INNER JOIN")
  })

  it("builds SELECT with LEFT JOIN", () => {
    const node = select()
      .from("users", "u")
      .leftJoin("posts", eq(col("u.id"), col("p.user_id")), "p")
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("LEFT JOIN")
  })

  it("builds SELECT with GROUP BY and HAVING", () => {
    const node = select(col("status"), fn("COUNT", [star()], "cnt"))
      .from("users")
      .groupBy("status")
      .having(eq(fn("COUNT", [star()]), lit(5)))
      .build()
    const result = pg.print(node)
    expect(result.sql).toContain("GROUP BY")
    expect(result.sql).toContain("HAVING")
  })

  it("builds SELECT with ORDER BY", () => {
    const node = select("id").from("users").orderBy("name", "ASC").orderBy("id", "DESC").build()
    const result = pg.print(node)
    expect(result.sql).toContain('ORDER BY "name" ASC, "id" DESC')
  })

  it("builds SELECT with ORDER BY NULLS FIRST", () => {
    const node = select("id").from("users").orderBy("name", "ASC", "FIRST").build()
    const result = pg.print(node)
    expect(result.sql).toContain("NULLS FIRST")
  })

  it("builds SELECT with LIMIT and OFFSET", () => {
    const node = select("id").from("users").limit(lit(10)).offset(lit(20)).build()
    const result = pg.print(node)
    expect(result.sql).toContain("LIMIT 10")
    expect(result.sql).toContain("OFFSET 20")
  })

  it("builds SELECT FOR UPDATE", () => {
    const node = select("id").from("users").forUpdate().build()
    expect(pg.print(node).sql).toContain("FOR UPDATE")
  })

  it("builds SELECT with CTE", () => {
    const cteQuery = select("id")
      .from("users")
      .where(eq(col("active"), lit(true)))
      .build()
    const node = select().with("active_users", cteQuery).from("active_users").build()
    const result = pg.print(node)
    expect(result.sql).toContain("WITH")
    expect(result.sql).toContain('"active_users"')
  })

  it("builds UNION query", () => {
    const q2 = select("id").from("admins").build()
    const node = select("id").from("users").union(q2).build()
    const result = pg.print(node)
    expect(result.sql).toContain("UNION")
  })

  it("builds UNION ALL query", () => {
    const q2 = select("id").from("admins").build()
    const node = select("id").from("users").unionAll(q2).build()
    const result = pg.print(node)
    expect(result.sql).toContain("UNION ALL")
  })

  it("is immutable - each method returns new builder", () => {
    const b1 = select("id").from("users")
    const b2 = b1.where(eq(col("id"), lit(1)))
    const b3 = b1.where(eq(col("id"), lit(2)))

    const r1 = pg.print(b1.build())
    const r2 = pg.print(b2.build())
    const r3 = pg.print(b3.build())

    expect(r1.sql).not.toContain("WHERE")
    expect(r2.sql).toContain("1")
    expect(r3.sql).toContain("2")
  })

  it("builds SELECT with table alias", () => {
    const node = select().from("users", "u").build()
    expect(pg.print(node).sql).toBe('SELECT * FROM "users" AS "u"')
  })
})
