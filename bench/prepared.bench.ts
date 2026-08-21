import { bench, describe } from "vitest"

import { placeholder } from "../src/builder/compiled.ts"
import { and } from "../src/builder/eb.ts"
import { pgDialect } from "../src/dialect/pg.ts"
import { sumak } from "../src/sumak.ts"
import { tables } from "./src/schema-sumak.ts"

/**
 * What a request pays, on each of the two paths.
 *
 * `compile.bench.ts` times the whole pipeline, which is what `.toSQL()` runs on
 * every call. That is the right measurement for a query whose shape genuinely
 * varies per request. It is the wrong one for the shape a request usually has,
 * where the query was written once and only the values change — and until this
 * file existed, nothing measured that at all.
 *
 * Run with:
 *   pnpm vitest bench --run bench/prepared.bench.ts
 */

const db = sumak({ dialect: pgDialect(), tables })

const scenarios = [
  {
    name: "select-all",
    live: () => db.selectFrom("users").selectAll().toSQL(),
    prepared: db.selectFrom("users").selectAll().toCompiled(),
    args: {},
  },
  {
    name: "select-where-eq",
    live: () =>
      db
        .selectFrom("users")
        .select("id", "name")
        .where(({ id }) => id.eq(1))
        .toSQL(),
    prepared: db
      .selectFrom("users")
      .select("id", "name")
      .where(({ id }) => id.eq(placeholder("id") as never))
      .toCompiled<{ id: number }>(),
    args: { id: 1 },
  },
  {
    name: "select-where-deep-and",
    live: () =>
      db
        .selectFrom("posts")
        .selectAll()
        .where(({ authorId, published, title, body, id }) =>
          and(authorId.eq(1), published.gt(0), title.neq(""), body.neq(""), id.gt(0)),
        )
        .toSQL(),
    prepared: db
      .selectFrom("posts")
      .selectAll()
      .where(({ authorId, published, title, body, id }) =>
        and(
          authorId.eq(placeholder("authorId") as never),
          published.gt(placeholder("published") as never),
          title.neq(placeholder("title") as never),
          body.neq(placeholder("body") as never),
          id.gt(placeholder("id") as never),
        ),
      )
      .toCompiled<{
        authorId: number
        published: number
        title: string
        body: string
        id: number
      }>(),
    args: { authorId: 1, published: 0, title: "", body: "", id: 0 },
  },
  {
    name: "insert-values",
    live: () =>
      db
        .insertInto("users")
        .values({ id: 1, name: "a", email: "a@x.io", createdAt: new Date(0) })
        .toSQL(),
    prepared: db
      .insertInto("users")
      .values({
        id: placeholder("id") as never,
        name: placeholder("name") as never,
        email: placeholder("email") as never,
        createdAt: placeholder("createdAt") as never,
      })
      .toCompiled<{ id: number; name: string; email: string; createdAt: Date }>(),
    args: { id: 1, name: "a", email: "a@x.io", createdAt: new Date(0) },
  },
  {
    name: "update-where",
    live: () =>
      db
        .update("users")
        .set({ name: "a" })
        .where(({ id }) => id.eq(1))
        .toSQL(),
    prepared: db
      .update("users")
      .set({ name: placeholder("name") as never })
      .where(({ id }) => id.eq(placeholder("id") as never))
      .toCompiled<{ name: string; id: number }>(),
    args: { name: "a", id: 1 },
  },
] as const

for (const sc of scenarios) {
  describe(sc.name, () => {
    bench("toSQL — recompiled per call", () => {
      sc.live()
    })
    bench("toCompiled — parameters only", () => {
      ;(sc.prepared as (args: unknown) => unknown)(sc.args)
    })
  })
}
