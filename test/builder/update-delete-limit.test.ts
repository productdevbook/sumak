import { describe, expect, it } from "vitest"

import { col, eq, lit } from "../../src/ast/expression.ts"
import { DeleteBuilder } from "../../src/builder/delete.ts"
import { UpdateBuilder } from "../../src/builder/update.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("UPDATE with ORDER BY and LIMIT (MySQL)", () => {
  const db = sumak({
    dialect: mysqlDialect(),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull(), age: integer() },
    },
  })
  const p = db.printer()

  it("UPDATE ... ORDER BY ... LIMIT", () => {
    const node = new UpdateBuilder()
      .table("users")
      .set("name", lit("Bob"))
      .where(eq(col("age"), lit(0)))
      .orderBy("id", "ASC")
      .limit(lit(10))
      .build()
    const q = p.print(node)
    expect(q.sql).toContain("UPDATE")
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("LIMIT")
  })

  it("UPDATE without ORDER BY/LIMIT still works", () => {
    const node = new UpdateBuilder()
      .table("users")
      .set("name", lit("Alice"))
      .where(eq(col("id"), lit(1)))
      .build()
    const q = p.print(node)
    expect(q.sql).not.toContain("ORDER BY")
    expect(q.sql).not.toContain("LIMIT")
  })
})

describe("DELETE with ORDER BY and LIMIT (MySQL)", () => {
  const db = sumak({
    dialect: mysqlDialect(),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull() },
    },
  })
  const p = db.printer()

  it("DELETE ... ORDER BY ... LIMIT", () => {
    const node = new DeleteBuilder()
      .from("users")
      .where(eq(col("name"), lit("test")))
      .orderBy("id", "DESC")
      .limit(lit(5))
      .build()
    const q = p.print(node)
    expect(q.sql).toContain("DELETE FROM")
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("LIMIT")
    expect(q.sql).toContain("DESC")
  })
})

describe("PG UPDATE/DELETE ignores ORDER BY/LIMIT", () => {
  const db = sumak({
    dialect: pgDialect(),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull() },
    },
  })
  const p = db.printer()

  it("PG UPDATE with ORDER BY still prints (PG would reject at runtime)", () => {
    const node = new UpdateBuilder()
      .table("users")
      .set("name", lit("Bob"))
      .orderBy("id")
      .limit(lit(1))
      .build()
    const q = p.print(node)
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("LIMIT")
  })
})
