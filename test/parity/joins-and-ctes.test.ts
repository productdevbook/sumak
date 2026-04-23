import { describe, it } from "vitest"

import { integer, serial, text } from "../../src/schema/index.ts"
import { assertParity } from "../helpers/parity.ts"

const TABLES = {
  users: { id: serial().primaryKey(), name: text().notNull() },
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    userId: integer().references("users", "id"),
  },
}

describe("parity: joins + CTEs", () => {
  it("INNER JOIN on two tables", () => {
    assertParity(
      (db) =>
        db
          .selectFrom("users")
          .innerJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))
          .select("id"),
      TABLES,
      {
        pg: `SELECT "id" FROM "users" INNER JOIN "posts" ON ("users"."id" = "posts"."userId")`,
        mysql: "SELECT `id` FROM `users` INNER JOIN `posts` ON (`users`.`id` = `posts`.`userId`)",
        sqlite: `SELECT "id" FROM "users" INNER JOIN "posts" ON ("users"."id" = "posts"."userId")`,
        mssql: `SELECT [id] FROM [users] INNER JOIN [posts] ON ([users].[id] = [posts].[userId])`,
      },
    )
  })

  it("LEFT JOIN shape", () => {
    assertParity(
      (db) =>
        db
          .selectFrom("users")
          .leftJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))
          .selectAll(),
      TABLES,
      {
        pg: `SELECT * FROM "users" LEFT JOIN "posts" ON ("users"."id" = "posts"."userId")`,
      },
    )
  })

  // LATERAL JOIN availability is covered by the dialect feature-matrix
  // tests and the printer-specific lateral-join suites; skipping here
  // to avoid depending on the exact `innerJoinLateral` call shape.

  it("simple CTE renders identically on pg/mysql/sqlite", () => {
    assertParity(
      (db) => {
        const active = db.selectFrom("users").select("id")
        return db.selectFrom("users").selectAll().with("active_users", active)
      },
      TABLES,
      {
        pg: `WITH "active_users" AS (SELECT "id" FROM "users") SELECT * FROM "users"`,
        mysql: "WITH `active_users` AS (SELECT `id` FROM `users`) SELECT * FROM `users`",
        sqlite: `WITH "active_users" AS (SELECT "id" FROM "users") SELECT * FROM "users"`,
      },
    )
  })
})
