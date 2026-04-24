import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { isAbortError } from "../../src/driver/types.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

// Builders forward `{ signal }` from `.many()` / `.one()` / `.first()`
// / `.exec()` into the driver. With an already-aborted signal the
// driver short-circuits before touching PG — the test driver throws an
// AbortError and sumak surfaces it unchanged.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS ab_users;
    CREATE TABLE ab_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO ab_users (name) VALUES ('Alice'), ('Bob');
  `)
})

afterAll(async () => {
  await pg?.close()
})

describe("builder .many/.one/.first/.exec — AbortSignal", () => {
  const schema = {
    ab_users: {
      id: serial().primaryKey(),
      name: text().notNull(),
    },
  }

  it(".many() short-circuits when signal is already aborted", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      db.selectFrom("ab_users").selectAll().many({ signal: ctrl.signal }),
    ).rejects.toSatisfy((e: unknown) => isAbortError(e))
  })

  it(".one() forwards signal", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      db
        .selectFrom("ab_users")
        .where(({ id }) => id.eq(1))
        .one({ signal: ctrl.signal }),
    ).rejects.toSatisfy((e: unknown) => isAbortError(e))
  })

  it(".first() forwards signal", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(db.selectFrom("ab_users").first({ signal: ctrl.signal })).rejects.toSatisfy(
      (e: unknown) => isAbortError(e),
    )
  })

  it(".exec() on UPDATE forwards signal", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      db
        .update("ab_users")
        .set({ name: "X" })
        .where(({ id }) => id.eq(1))
        .exec({ signal: ctrl.signal }),
    ).rejects.toSatisfy((e: unknown) => isAbortError(e))
  })

  it("no signal — query runs and returns rows as usual", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db.selectFrom("ab_users").selectAll().many()
    expect(rows).toHaveLength(2)
  })
})
