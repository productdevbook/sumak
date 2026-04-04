import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { QueryLimitPlugin } from "../../src/plugin/query-limit.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("QueryLimitPlugin", () => {
  it("adds default LIMIT 1000 to SELECT without LIMIT", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [new QueryLimitPlugin()],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.selectFrom("users").select("id").toSQL()
    expect(q.sql).toContain("LIMIT 1000")
  })

  it("custom maxRows", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [new QueryLimitPlugin({ maxRows: 100 })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.selectFrom("users").select("id").toSQL()
    expect(q.sql).toContain("LIMIT 100")
  })

  it("does NOT override existing LIMIT", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [new QueryLimitPlugin({ maxRows: 1000 })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.selectFrom("users").select("id").limit(5).toSQL()
    expect(q.sql).toContain("LIMIT 5")
    expect(q.sql).not.toContain("LIMIT 1000")
  })

  it("does not affect INSERT", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [new QueryLimitPlugin()],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db.insertInto("users").values({ name: "Alice" }).toSQL()
    expect(q.sql).not.toContain("LIMIT")
  })

  it("does not affect UPDATE", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [new QueryLimitPlugin()],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).not.toContain("LIMIT 1000")
  })
})
