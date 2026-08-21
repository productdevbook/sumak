import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"
import { parseColumnRef } from "../../src/utils/column-ref.ts"

// `select("posts.id")` used to emit `SELECT "posts.id"` — one identifier, a
// column no table has. Postgres answers `column "posts.id" does not exist`.
// The repo's own benchmark used that form, which is how it survived: the
// benchmark was outside `tsconfig.json`'s `include`, so nothing checked it.

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

describe("a dotted column name is a qualifier, not a name", () => {
  it("qualifies a selected column", () => {
    const q = db
      .selectFrom("posts")
      .innerJoin("users", ({ posts, users }) => posts.authorId.eq(users.id))
      .select("posts.id", "posts.title")
      .toSQL()

    expect(q.sql).toContain('SELECT "posts"."id", "posts"."title"')
    expect(q.sql).not.toContain('"posts.id"')
  })

  it("qualifies group by and order by", () => {
    const grouped = db.selectFrom("posts").select("posts.authorId").toSQL()
    expect(grouped.sql).toContain('"posts"."authorId"')
  })

  it("leaves an unqualified name alone", () => {
    expect(parseColumnRef("id")).toEqual({ type: "column_ref", column: "id", table: undefined })
  })

  it("splits one qualifier", () => {
    expect(parseColumnRef("posts.id")).toEqual({
      type: "column_ref",
      column: "id",
      table: "posts",
    })
  })

  it("leaves a deeper name whole rather than guessing", () => {
    expect(parseColumnRef("a.b.c")).toEqual({
      type: "column_ref",
      column: "a.b.c",
      table: undefined,
    })
  })

  it("takes a name with a quote in it raw, for the printer to escape", () => {
    expect(parseColumnRef('col"name')).toEqual({
      type: "column_ref",
      column: 'col"name',
      table: undefined,
    })
  })

  it("refuses an empty half", () => {
    expect(() => parseColumnRef("posts.")).toThrow(/must both be non-empty/)
    expect(() => parseColumnRef(".id")).toThrow(/must both be non-empty/)
  })
})
