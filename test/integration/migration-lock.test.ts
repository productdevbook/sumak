import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import type { QueryEvent } from "../../src/driver/types.ts"
import { applyMigration } from "../../src/migrate/runner.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
})

afterAll(async () => {
  await pg?.close()
})

describe("applyMigration — advisory lock", () => {
  it("PG: acquires pg_advisory_lock and releases it around the DDL", async () => {
    const events: QueryEvent[] = []
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      tables: {
        ml_t: { id: serial().primaryKey(), name: text().notNull() },
      },
      onQuery: (e) => events.push(e),
    })

    await applyMigration(db, {}, { ml_t: { id: serial().primaryKey(), name: text().notNull() } })

    const sqls = events.filter((e) => e.phase === "start").map((e) => e.sql)
    // The lock SQL should appear once at the start and once at the
    // end of the migration (unlock). Both reference
    // pg_advisory_lock / pg_advisory_unlock.
    expect(sqls.some((s) => /pg_advisory_lock/.test(s))).toBe(true)
    expect(sqls.some((s) => /pg_advisory_unlock/.test(s))).toBe(true)
  })

  it("lock: false skips the advisory primitive entirely", async () => {
    const events: QueryEvent[] = []
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: pgDialect(),
      driver,
      tables: {
        ml_nolock: { id: serial().primaryKey() },
      },
      onQuery: (e) => events.push(e),
    })

    await applyMigration(db, {}, { ml_nolock: { id: serial().primaryKey() } }, { lock: false })

    const sqls = events.filter((e) => e.phase === "start").map((e) => e.sql)
    expect(sqls.some((s) => /pg_advisory/.test(s))).toBe(false)
  })

  it("SQLite: no lock SQL emitted — SQLite uses engine-level file lock", async () => {
    // Use a pg-shaped test driver but configure sumak with the
    // sqlite dialect so the runner picks the sqlite branch. No
    // actual queries fire through the driver beyond the DDL itself.
    const { sqliteDialect } = await import("../../src/dialect/sqlite.ts")
    const events: QueryEvent[] = []
    const driver = pgliteDriver(pg)
    const db = sumak({
      dialect: sqliteDialect(),
      driver,
      tables: {
        ml_sqlite: { id: serial().primaryKey() },
      },
      onQuery: (e) => events.push(e),
    })
    // Expect the CREATE TABLE to fire but no lock SQL.
    try {
      await applyMigration(
        db,
        {},
        { ml_sqlite: { id: serial().primaryKey() } },
        { transaction: false },
      )
    } catch {
      // pglite parses sqlite dialect's DDL as PG SQL — the CREATE
      // itself may or may not execute cleanly. What we're asserting
      // is only the lock-sql absence, which holds either way.
    }
    const sqls = events.filter((e) => e.phase === "start").map((e) => e.sql)
    expect(sqls.some((s) => /GET_LOCK|pg_advisory|sp_getapplock/.test(s))).toBe(false)
  })
})
