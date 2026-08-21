import { PGlite } from "@electric-sql/pglite"
import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// The unit test pins the string; this asks Postgres whether it accepts it.
// That question is what caught the defect: `SELECT "posts.id"` parses fine and
// fails only at name resolution, so no amount of reading the string finds it.

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: { id: serial().primaryKey(), name: text().notNull() },
    posts: {
      id: serial().primaryKey(),
      authorId: integer().notNull(),
      title: text().notNull(),
    },
  },
})

describe("postgres accepts the SQL we emit for qualified columns", () => {
  it("runs a join that selects qualified columns", async () => {
    const pg = new PGlite()
    await pg.exec(`
      CREATE TABLE users (id serial primary key, name text not null);
      CREATE TABLE posts (
        id serial primary key,
        "authorId" integer not null,
        title text not null
      );
      INSERT INTO users (name) VALUES ('ada');
      INSERT INTO posts ("authorId", title) VALUES (1, 'hello');
    `)

    const q = db
      .selectFrom("posts")
      .innerJoin("users", ({ posts, users }) => posts.authorId.eq(users.id))
      .select("posts.id", "posts.title", "users.name")
      .toSQL()

    const result = await pg.query(q.sql, q.params as unknown[])
    expect(result.rows).toEqual([{ id: 1, title: "hello", name: "ada" }])
  }, 60_000)
})
