import { describe, it } from "vitest"

import { UnsupportedDialectFeatureError } from "../../src/errors.ts"
import { boolean, integer, serial, text } from "../../src/schema/index.ts"
import { assertParity } from "../helpers/parity.ts"

// Dialect parity for core DML — the smallest build chain that exercises
// identifier quoting + param placeholder style + basic clause ordering.
// If any of these diverge, every higher-level feature will too.

const TABLES = {
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
    age: integer().nullable(),
    active: boolean().nullable(),
  },
}

describe("parity: core DML", () => {
  it("SELECT * FROM users", () => {
    assertParity((db) => db.selectFrom("users").selectAll(), TABLES, {
      pg: `SELECT * FROM "users"`,
      mysql: "SELECT * FROM `users`",
      sqlite: `SELECT * FROM "users"`,
      mssql: `SELECT * FROM [users]`,
    })
  })

  it("SELECT columns with WHERE + param style differs per dialect", () => {
    assertParity(
      (db) =>
        db
          .selectFrom("users")
          .select("id", "name")
          .where(({ id }) => id.eq(1)),
      TABLES,
      {
        pg: { sql: `SELECT "id", "name" FROM "users" WHERE ("id" = $1)`, params: [1] },
        mysql: { sql: "SELECT `id`, `name` FROM `users` WHERE (`id` = ?)", params: [1] },
        sqlite: { sql: `SELECT "id", "name" FROM "users" WHERE ("id" = ?)`, params: [1] },
        mssql: { sql: `SELECT [id], [name] FROM [users] WHERE ([id] = @p0)`, params: [1] },
      },
    )
  })

  it("INSERT ... RETURNING works on pg/sqlite, throws on mysql/mssql", () => {
    assertParity((db) => db.insertInto("users").values({ name: "Alice" }).returning("id"), TABLES, {
      pg: {
        sql: `INSERT INTO "users" ("name") VALUES ($1) RETURNING "id"`,
        params: ["Alice"],
      },
      sqlite: {
        sql: `INSERT INTO "users" ("name") VALUES (?) RETURNING "id"`,
        params: ["Alice"],
      },
      mysql: { throws: UnsupportedDialectFeatureError },
    })
  })

  it("DISTINCT ON is PG-only", () => {
    assertParity(
      (db) => db.selectFrom("users").selectAll().distinctOn("age").orderBy("age"),
      TABLES,
      {
        pg: `SELECT DISTINCT ON ("age") * FROM "users" ORDER BY "age" ASC`,
        mysql: { throws: UnsupportedDialectFeatureError },
        sqlite: { throws: UnsupportedDialectFeatureError },
        mssql: { throws: UnsupportedDialectFeatureError },
      },
    )
  })

  it("LIMIT / OFFSET with literal numbers inlines per dialect", () => {
    assertParity((db) => db.selectFrom("users").selectAll().limit(10).offset(20), TABLES, {
      pg: `SELECT * FROM "users" LIMIT 10 OFFSET 20`,
      mysql: "SELECT * FROM `users` LIMIT 10 OFFSET 20",
      sqlite: `SELECT * FROM "users" LIMIT 10 OFFSET 20`,
      // MSSQL has its own OFFSET … FETCH syntax — asserted separately.
      mssql: undefined,
    })
  })

  it("UPDATE with param + WHERE", () => {
    assertParity(
      (db) =>
        db
          .update("users")
          .set({ active: false })
          .where(({ id }) => id.eq(7)),
      TABLES,
      {
        pg: {
          sql: `UPDATE "users" SET "active" = $1 WHERE ("id" = $2)`,
          params: [false, 7],
        },
        mysql: {
          sql: "UPDATE `users` SET `active` = ? WHERE (`id` = ?)",
          params: [false, 7],
        },
        sqlite: {
          sql: `UPDATE "users" SET "active" = ? WHERE ("id" = ?)`,
          params: [false, 7],
        },
      },
    )
  })

  it("DELETE with WHERE", () => {
    assertParity((db) => db.deleteFrom("users").where(({ id }) => id.eq(99)), TABLES, {
      pg: { sql: `DELETE FROM "users" WHERE ("id" = $1)`, params: [99] },
      mysql: { sql: "DELETE FROM `users` WHERE (`id` = ?)", params: [99] },
      sqlite: { sql: `DELETE FROM "users" WHERE ("id" = ?)`, params: [99] },
      mssql: { sql: `DELETE FROM [users] WHERE ([id] = @p0)`, params: [99] },
    })
  })
})
