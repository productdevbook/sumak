import { PGlite } from "@electric-sql/pglite"
import { beforeAll, describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { sumak } from "../../src/index.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { pgliteDriver } from "../integration/pglite-driver.ts"

// `.with()` used to return the same builder type it was called on, so the CTE
// name was not a table anyone could join. `bench/src/scenarios.ts` reached for
// `"recent_posts" as never` and an `any` callback to measure the shape at all,
// which is a footgun standing where a type should be.

let pg: PGlite
let db: ReturnType<typeof make>

function make(engine: PGlite) {
  return sumak({
    dialect: pgDialect(),
    driver: pgliteDriver(engine),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull() },
      posts: {
        id: serial().primaryKey(),
        authorId: integer().notNull(),
        published: integer().notNull(),
      },
    },
  })
}

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE users (id integer primary key, name text not null);
    CREATE TABLE posts (id integer primary key, "authorId" integer not null, published integer not null);
    INSERT INTO users VALUES (1, 'ada'), (2, 'grace');
    INSERT INTO posts VALUES (1, 1, 1), (2, 1, 0), (3, 2, 1);
  `)
  db = make(pg)
}, 60_000)

describe("a CTE is a table you can join", () => {
  it("carries the CTE's columns into the join, with their types", async () => {
    const recent = db
      .selectFrom("posts")
      .select("id", "authorId")
      .where(({ published }) => published.gt(0))

    const rows = await db
      .selectFrom("users")
      .with("recent_posts", recent)
      .innerJoin("recent_posts", ({ users, recent_posts }) => users.id.eq(recent_posts.authorId))
      .select("users.id", "users.name")
      .many()

    expect(rows.map((r) => r.name).sort()).toEqual(["ada", "grace"])
  })

  it("names an unknown CTE column as an error", () => {
    const recent = db.selectFrom("posts").select("id", "authorId")

    db.selectFrom("users")
      .with("recent_posts", recent)
      // @ts-expect-error published is not in the CTE's projection
      .innerJoin("recent_posts", ({ users, recent_posts }) => users.id.eq(recent_posts.published))
  })

  it("still accepts a bare node, widening the CTE's row", () => {
    const built = db
      .selectFrom("users")
      .with("anything", db.selectFrom("posts").select("id").build())
      .selectAll()
      .toSQL()

    expect(built.sql).toContain('WITH "anything"')
  })

  it("emits the CTE ahead of the query", async () => {
    const recent = db
      .selectFrom("posts")
      .select("id", "authorId")
      .where(({ published }) => published.gt(0))

    const { sql } = db
      .selectFrom("users")
      .with("recent_posts", recent)
      .innerJoin("recent_posts", ({ users, recent_posts }) => users.id.eq(recent_posts.authorId))
      .select("users.name")
      .toSQL()

    expect(sql.startsWith('WITH "recent_posts" AS')).toBe(true)
    expect(sql).toContain('INNER JOIN "recent_posts"')
  })
})
