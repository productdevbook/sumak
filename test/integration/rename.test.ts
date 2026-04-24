import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
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

describe("rename — pglite roundtrip", () => {
  it("column rename preserves the existing row's data", async () => {
    const driver = pgliteDriver(pg)
    const before = {
      rn_people: { id: serial().primaryKey(), user_name: text().notNull() },
    }
    const after = {
      rn_people: { id: serial().primaryKey(), name: text().notNull() },
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: after })
    await applyMigration(db, {}, before)
    await db
      .insertInto("rn_people")
      .values({ id: 1, user_name: "Alice" } as any)
      .exec()

    await applyMigration(db, before, after, {
      renames: { columns: { "rn_people.user_name": "name" } },
    })

    // Read back through the post-rename column.
    const rows = await db.selectFrom("rn_people").selectAll().many()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe("Alice")
  })

  it("table rename preserves rows", async () => {
    const driver = pgliteDriver(pg)
    const before = {
      rn_old: { id: serial().primaryKey(), title: text().notNull() },
    }
    const after = {
      rn_new: { id: serial().primaryKey(), title: text().notNull() },
    }
    const db = sumak({ dialect: pgDialect(), driver, tables: after })
    await applyMigration(db, {}, before)
    // Seed via the old table (driver-level SQL).
    await db.executeCompiled({
      sql: `INSERT INTO "rn_old" ("id", "title") VALUES (1, 'hi')`,
      params: [],
    })

    await applyMigration(db, before, after, { renames: { tables: { rn_old: "rn_new" } } })

    const rows = await db.selectFrom("rn_new").selectAll().many()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("hi")
  })
})
