import { PGlite } from "@electric-sql/pglite"
import { beforeEach, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { sumak } from "../../src/index.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

// `db.mergeInto(...)` was a public entry point producing a query nobody could
// run: the builder carried no executor, so there was no `.run()`, no `.many()`,
// and a compiled MERGE rejected. Callers had to take the SQL and drive the
// connection themselves — which is the one thing the rest of the API does for
// them.

let pg: PGlite
let db: ReturnType<typeof make>

function make(engine: PGlite) {
  return sumak({
    dialect: pgDialect(),
    driver: pgliteDriver(engine),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull(), score: integer().notNull() },
      staging: { id: serial().primaryKey(), name: text().notNull(), score: integer().notNull() },
    },
  })
}

beforeEach(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE users (id integer primary key, name text not null, score integer not null);
    CREATE TABLE staging (id integer primary key, name text not null, score integer not null);
    INSERT INTO users VALUES (1, 'ada', 10);
    INSERT INTO staging VALUES (1, 'ada', 99), (2, 'grace', 50);
  `)
  db = make(pg)
}, 60_000)

function merge() {
  return db
    .mergeInto("users", {
      source: "staging",
      on: ({ target, source }) => target.id.eq(source.id),
    })
    .whenMatchedThenUpdate({ score: 0 })
    .whenNotMatchedThenInsert({ id: 0, name: "", score: 0 })
}

describe("MERGE runs", () => {
  it("reports how many rows it touched", async () => {
    const affected = await db
      .mergeInto("users", {
        source: "staging",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ score: 1 })
      .run()

    expect(affected).toBe(1)
    const rows = await pg.query<{ score: number }>("SELECT score FROM users WHERE id = 1")
    expect(rows.rows[0]?.score).toBe(1)
  })

  it("returns the rows a RETURNING clause produces", async () => {
    const rows = await db
      .mergeInto("users", {
        source: "staging",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ score: 7 })
      .returningAll()
      .many()

    expect(rows).toHaveLength(1)
    expect((rows[0] as { score: number }).score).toBe(7)
  })

  it("compiles once and runs", async () => {
    const compiled = db
      .mergeInto("users", {
        source: "staging",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ score: 3 })
      .toCompiled()

    expect(await compiled.run({})).toBe(1)
    expect(compiled.sql).toContain("MERGE INTO")

    const rows = await pg.query<{ score: number }>("SELECT score FROM users WHERE id = 1")
    expect(rows.rows[0]?.score).toBe(3)
  })

  it("says what is missing when there is no driver", async () => {
    const detached = sumak({
      dialect: pgDialect(),
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull(), score: integer().notNull() },
        staging: { id: serial().primaryKey(), name: text().notNull(), score: integer().notNull() },
      },
    })
      .mergeInto("users", {
        source: "staging",
        on: ({ target, source }) => target.id.eq(source.id),
      })
      .whenMatchedThenUpdate({ score: 1 })

    await expect(detached.run()).rejects.toThrow(/No driver configured/)
    expect(merge().build().type).toBe("merge")
  })
})

describe("EXPLAIN reads its plan", () => {
  it("returns the rows the engine prints", async () => {
    const plan = await db.selectFrom("users").selectAll().explain().many()

    expect(plan.length).toBeGreaterThan(0)
    expect(JSON.stringify(plan)).toMatch(/users/i)
  })

  it("still compiles without a driver, and says so when run", async () => {
    const detached = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
    })
      .selectFrom("users")
      .selectAll()
      .explain()

    await expect(detached.many()).rejects.toThrow(/No driver configured/)
    expect(detached.toSQL().sql).toContain("EXPLAIN")
  })
})
