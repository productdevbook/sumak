import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { any, arrayLiteral, val } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { pgliteDriver } from "./pglite-driver.ts"

// Real-PG evidence that ANY(ARRAY[...]) + ANY(subquery) compile and
// match the rows you'd expect.

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    DROP TABLE IF EXISTS q_users CASCADE;
    DROP TABLE IF EXISTS q_admins CASCADE;
    CREATE TABLE q_users (id SERIAL PRIMARY KEY, role TEXT NOT NULL);
    CREATE TABLE q_admins (id INT PRIMARY KEY, user_id INT NOT NULL);
    INSERT INTO q_users (role) VALUES ('admin'), ('editor'), ('viewer');
    INSERT INTO q_admins (id, user_id) VALUES (1, 1), (2, 2);
  `)
})

afterAll(async () => {
  await pg?.close()
})

const schema = {
  q_users: { id: serial().primaryKey(), role: text().notNull() },
  q_admins: { id: integer().primaryKey(), user_id: integer().notNull() },
}

describe("ANY/ALL against pglite", () => {
  it("WHERE role = ANY(ARRAY['admin','editor'])", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const rows = await db
      .selectFrom("q_users")
      .where(({ role }) => role.eq(any<string>(arrayLiteral([val("admin"), val("editor")]))))
      .selectAll()
      .many()
    expect(rows.map((r) => r.role).sort()).toEqual(["admin", "editor"])
  })

  it("WHERE id = ANY(SELECT user_id FROM q_admins)", async () => {
    const db = sumak({ dialect: pgDialect(), driver: pgliteDriver(pg), tables: schema })
    const admins = db.selectFrom("q_admins").select("user_id").build()
    const rows = await db
      .selectFrom("q_users")
      .where(({ id }) => id.eq(any({ node: { type: "subquery", query: admins } } as any)))
      .selectAll()
      .many()
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2])
  })
})
