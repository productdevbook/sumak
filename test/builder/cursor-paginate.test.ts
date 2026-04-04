import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      age: integer(),
    },
  },
})

describe("cursorPaginate()", () => {
  it("first page — no cursor, just LIMIT", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .cursorPaginate({ column: "id", pageSize: 20 })
      .toSQL()
    expect(q.sql).toContain("LIMIT 21")
    expect(q.sql).not.toContain(">")
    expect(q.sql).not.toContain("<")
  })

  it("forward pagination — after cursor", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .cursorPaginate({ column: "id", after: 42, pageSize: 10 })
      .toSQL()
    expect(q.sql).toContain(">")
    expect(q.sql).toContain("ORDER BY")
    expect(q.sql).toContain("ASC")
    expect(q.sql).toContain("LIMIT 11")
    expect(q.params).toContain(42)
  })

  it("backward pagination — before cursor", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .cursorPaginate({ column: "id", before: 100, pageSize: 10 })
      .toSQL()
    expect(q.sql).toContain("<")
    expect(q.sql).toContain("DESC")
    expect(q.sql).toContain("LIMIT 11")
    expect(q.params).toContain(100)
  })

  it("preserves existing WHERE", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ name }) => name.eq("Alice"))
      .cursorPaginate({ column: "id", after: 5, pageSize: 10 })
      .toSQL()
    expect(q.sql).toContain("AND")
    expect(q.params).toContain("Alice")
    expect(q.params).toContain(5)
  })

  it("pageSize + 1 for hasNextPage detection", () => {
    const q = db
      .selectFrom("users")
      .select("id")
      .cursorPaginate({ column: "id", pageSize: 50 })
      .toSQL()
    expect(q.sql).toContain("LIMIT 51")
  })
})
