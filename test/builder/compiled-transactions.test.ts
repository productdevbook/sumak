import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { pgDriver } from "../../src/drivers/pg.ts"
import type { PgStatement } from "../../src/drivers/pg.ts"
import { placeholder, sumak } from "../../src/index.ts"
import { integer, serial, text } from "../../src/schema/column.ts"

// A compiled query captures the instance it was built from — that is what lets
// it run itself. Inside a transaction that is the wrong instance: the
// transaction holds its own connection, so a query compiled outside sends its
// statement down the pool and commits while the transaction around it rolls
// back. pglite cannot show this because it has one connection; a pool can.

function recordingPool() {
  const pool: string[] = []
  const client: string[] = []
  const checkedOut = {
    query(sqlOrConfig: string | PgStatement) {
      client.push(typeof sqlOrConfig === "string" ? sqlOrConfig : sqlOrConfig.text)
      return Promise.resolve({ rows: [] as Record<string, unknown>[], rowCount: 1 })
    },
    release() {},
  }
  return {
    pool,
    client,
    query(sqlOrConfig: string | PgStatement) {
      pool.push(typeof sqlOrConfig === "string" ? sqlOrConfig : sqlOrConfig.text)
      return Promise.resolve({ rows: [] as Record<string, unknown>[], rowCount: 1 })
    },
    connect: () => Promise.resolve(checkedOut),
  }
}

function make(spy: ReturnType<typeof recordingPool>) {
  return sumak({
    dialect: pgDialect(),
    driver: pgDriver(spy),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull(), age: integer().notNull() },
    },
  })
}

function addUser(db: ReturnType<typeof make>) {
  return db
    .insertInto("users")
    .values({ name: placeholder("name") as never, age: placeholder("age") as never })
    .toCompiled<{ name: string; age: number }>()
}

describe("a compiled query inside a transaction", () => {
  it("goes to the pool when it was compiled outside — which is the trap", async () => {
    const spy = recordingPool()
    const db = make(spy)
    const add = addUser(db)

    await db.transaction(async () => {
      await add.run({ name: "escapes", age: 1 })
    })

    expect(spy.client).toEqual(["BEGIN", "COMMIT"])
    expect(spy.pool.some((sql) => sql.startsWith("INSERT"))).toBe(true)
  })

  it("goes to the transaction's connection once bound to it", async () => {
    const spy = recordingPool()
    const db = make(spy)
    const add = addUser(db)

    await db.transaction(async (tx) => {
      await tx.prepared(add).run({ name: "inside", age: 1 })
    })

    expect(spy.pool.some((sql) => sql.startsWith("INSERT"))).toBe(false)
    expect(spy.client.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(1)
    expect(spy.client[0]).toBe("BEGIN")
    expect(spy.client.at(-1)).toBe("COMMIT")
  })

  it("rolls the bound write back with the transaction", async () => {
    const spy = recordingPool()
    const db = make(spy)
    const add = addUser(db)

    await expect(
      db.transaction(async (tx) => {
        await tx.prepared(add).run({ name: "rolled back", age: 1 })
        throw new Error("no")
      }),
    ).rejects.toThrow("no")

    expect(spy.client.at(-1)).toBe("ROLLBACK")
    expect(spy.pool.some((sql) => sql.startsWith("INSERT"))).toBe(false)
  })

  it("leaves the original compiled query alone", async () => {
    const spy = recordingPool()
    const db = make(spy)
    const add = addUser(db)

    await db.transaction(async (tx) => {
      await tx.prepared(add).run({ name: "inside", age: 1 })
    })
    await add.run({ name: "outside", age: 2 })

    expect(spy.pool.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(1)
  })
})
