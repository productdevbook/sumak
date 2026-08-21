import { PGlite } from "@electric-sql/pglite"
import { beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { compileQuery, placeholder, sumak } from "../../src/index.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

// A compiled query is the fast path, and until it could reach the driver it was
// also the inconvenient one — the caller had to hold `{ sql, params }` and drive
// the connection themselves, so nobody did. These run it end to end.

let db: ReturnType<typeof make>

function make(pg: PGlite) {
  return sumak({
    dialect: pgDialect(),
    driver: pgliteDriver(pg),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull(), age: integer().notNull() },
    },
  })
}

beforeAll(async () => {
  const pg = new PGlite()
  await pg.exec(`
    CREATE TABLE users (id serial primary key, name text not null, age integer not null);
    INSERT INTO users (name, age) VALUES ('ada', 36), ('grace', 45), ('alan', 41);
  `)
  db = make(pg)
}, 60_000)

describe("a compiled query runs", () => {
  it("returns every matching row", async () => {
    const olderThan = db
      .selectFrom("users")
      .select("name", "age")
      .where(({ age }) => age.gt(placeholder("age") as never))
      .toCompiled<{ age: number }>()

    const rows = await olderThan.many({ age: 40 })
    expect(rows.map((r) => r.name).sort()).toEqual(["alan", "grace"])

    // Same compiled query, different value — the SQL never changed.
    expect((await olderThan.many({ age: 44 })).map((r) => r.name)).toEqual(["grace"])
  })

  it("returns one row, or says why it cannot", async () => {
    const byName = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ name }) => name.eq(placeholder("name") as never))
      .toCompiled<{ name: string }>()

    expect((await byName.one({ name: "ada" })).name).toBe("ada")
    await expect(byName.one({ name: "nobody" })).rejects.toThrow(/expected exactly one row/)
  })

  it("returns the first row or null", async () => {
    const byName = db
      .selectFrom("users")
      .select("name")
      .where(({ name }) => name.eq(placeholder("name") as never))
      .toCompiled<{ name: string }>()

    expect(await byName.first({ name: "grace" })).toEqual({ name: "grace" })
    expect(await byName.first({ name: "nobody" })).toBeNull()
  })

  it("types the rows it hands back", async () => {
    const query = db.selectFrom("users").select("name", "age").toCompiled<Record<string, never>>()

    const rows = await query.many({})
    const first: { name: string; age: number } | undefined = rows[0]
    expect(first?.name).toBeTypeOf("string")
    expect(first?.age).toBeTypeOf("number")
  })

  it("still compiles without a driver, and says so when run", async () => {
    const detached = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
      .selectFrom("users")
      .select("id")
      .toCompiled()

    expect(detached.sql).toContain("SELECT")
    await expect(detached.many({})).rejects.toThrow(/No driver configured/)
  })

  it("says what is missing when compiled from a bare AST", async () => {
    const detached = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
    const compiled = compileQuery(
      detached.selectFrom("users").select("id").build(),
      detached.printer(),
    )

    expect(compiled.sql).toContain("SELECT")
    await expect(compiled.many({})).rejects.toThrow(/needs an instance with a driver/)
  })
})
