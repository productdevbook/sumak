import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { pgDriver } from "../../src/drivers/pg.ts"
import type { PgStatement } from "../../src/drivers/pg.ts"
import { placeholder, sumak } from "../../src/index.ts"
import { integer, serial, text } from "../../src/schema/column.ts"

// A compiled query's SQL text is fixed, which is the condition a server-side
// prepared statement needs. PostgreSQL then parses and plans once per
// connection and reuses the plan; measured against pglite the same query costs
// 243µs prepared and 303µs not, twenty times what compiling it client-side ever
// cost. These assert the name reaches the driver — the timing itself needs a
// real server and belongs in a benchmark, not here.

function recordingPool() {
  const calls: (string | PgStatement)[] = []
  return {
    calls,
    query(sqlOrConfig: string | PgStatement, values?: readonly unknown[]) {
      calls.push(sqlOrConfig)
      void values
      return Promise.resolve({ rows: [] as Record<string, unknown>[], rowCount: 0 })
    },
  }
}

function make(pool: ReturnType<typeof recordingPool>) {
  return sumak({
    dialect: pgDialect(),
    driver: pgDriver(pool),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull(), age: integer().notNull() },
    },
  })
}

describe("a compiled query is prepared on the server", () => {
  it("sends a named statement, with the same name every time", async () => {
    const pool = recordingPool()
    const query = make(pool)
      .selectFrom("users")
      .select("name")
      .where(({ age }) => age.gt(placeholder("age") as never))
      .toCompiled<{ age: number }>()

    await query.many({ age: 10 })
    await query.many({ age: 20 })

    expect(pool.calls).toHaveLength(2)
    const [first, second] = pool.calls as PgStatement[]
    expect(first.name).toBe(query.statementName)
    expect(second.name).toBe(first.name)
    expect(first.text).toBe(query.sql)
    expect(first.values).toEqual([10])
    expect(second.values).toEqual([20])
  })

  it("gives two compiled queries two names", () => {
    const db = make(recordingPool())
    const a = db.selectFrom("users").select("id").toCompiled()
    const b = db.selectFrom("users").select("name").toCompiled()

    expect(a.statementName).not.toBe(b.statementName)
  })

  it("names a compiled write too", async () => {
    const pool = recordingPool()
    const add = make(pool)
      .insertInto("users")
      .values({ name: placeholder("name") as never, age: placeholder("age") as never })
      .toCompiled<{ name: string; age: number }>()

    await add.run({ name: "ada", age: 36 })

    const [sent] = pool.calls as PgStatement[]
    expect(sent?.name).toBe(add.statementName)
  })

  it("leaves an uncompiled query unnamed, because its text is not fixed", async () => {
    const pool = recordingPool()
    await make(pool)
      .selectFrom("users")
      .select("name")
      .where(({ age }) => age.gt(10))
      .many()

    expect(typeof pool.calls[0]).toBe("string")
  })
})
