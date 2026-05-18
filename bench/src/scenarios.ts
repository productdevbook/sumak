import { and, avg, count, desc, eq, gt, inArray, max, ne, or as drizzleOr } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pg-proxy"
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely"

import { typedCol } from "../../src/ast/typed-expression.ts"
import {
  and as sand,
  avg as savg,
  count as scount,
  max as smax,
  or as sor,
} from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sumak } from "../../src/sumak.ts"
import { comments as dComments, posts as dPosts, users as dUsers } from "./schema-drizzle.ts"
import type { BenchDatabase } from "./schema-kysely.ts"
import { tables } from "./schema-sumak.ts"

/**
 * Sumak instance configured against the pg dialect. Query compilation
 * is pure — no driver needed to turn the AST into SQL + params — so
 * we leave `driver` off. The same instance is reused across benchmark
 * iterations; each `.toSQL()` call builds a fresh AST.
 */
const s = sumak({ dialect: pgDialect(), tables })

/**
 * Drizzle's compile path requires a drizzle instance. We use the
 * `pg-proxy` driver with a noop callback — it never fires on
 * `.toSQL()`, which is the only thing the benchmark exercises.
 */
const d = drizzle(async () => ({ rows: [] }), {
  schema: { users: dUsers, posts: dPosts, comments: dComments },
})

/**
 * Kysely with the DummyDriver — compile-only, rejects actual execute.
 * `.compile()` is what we measure.
 */
const k = new Kysely<BenchDatabase>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

export interface Result {
  readonly sql: string
  readonly params: readonly unknown[]
}

export interface Scenario {
  readonly name: string
  readonly sumak: () => Result
  readonly drizzle: () => Result
  readonly kysely: () => Result
}

function drizzleToResult(r: { sql: string; params: unknown[] }): Result {
  return { sql: r.sql, params: r.params }
}

function kyselyToResult(r: { sql: string; parameters: readonly unknown[] }): Result {
  return { sql: r.sql, params: r.parameters }
}

// A reusable 100-value list — built once so the bench doesn't measure
// allocator overhead for the array itself, just the compile cost.
const IDS_100 = Array.from({ length: 100 }, (_, i) => i + 1)

// Realistic insert payload — the 100 here trades real-world plausibility
// (you wouldn't bulk insert 10,000 rows in a single statement anyway)
// against a row count high enough to make the VALUES list dominate.
const INSERT_MANY_ROWS = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  name: `user-${i}`,
  email: `user-${i}@x.io`,
  createdAt: new Date(0),
}))

export const scenarios: Scenario[] = [
  {
    name: "select-all",
    sumak: () => s.selectFrom("users").selectAll().toSQL(),
    drizzle: () => drizzleToResult(d.select().from(dUsers).toSQL()),
    kysely: () => kyselyToResult(k.selectFrom("users").selectAll().compile()),
  },
  {
    name: "select-where-eq",
    sumak: () =>
      s
        .selectFrom("users")
        .select("id", "name")
        .where(({ id }) => id.eq(42))
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ id: dUsers.id, name: dUsers.name })
          .from(dUsers)
          .where(eq(dUsers.id, 42))
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(k.selectFrom("users").select(["id", "name"]).where("id", "=", 42).compile()),
  },
  {
    name: "select-where-and",
    sumak: () =>
      s
        .selectFrom("posts")
        .selectAll()
        .where(({ authorId, published }) => sand(authorId.eq(7), published.gt(0)))
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select()
          .from(dPosts)
          .where(and(eq(dPosts.authorId, 7), gt(dPosts.published, 0)))
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .selectAll()
          .where("authorId", "=", 7)
          .where("published", ">", 0)
          .compile(),
      ),
  },
  {
    name: "join-2-tables",
    sumak: () =>
      s
        .selectFrom("posts")
        .innerJoin("users", ({ posts, users }) => posts.authorId.eq(users.id))
        .select("posts.id", "posts.title", "users.name")
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ id: dPosts.id, title: dPosts.title, name: dUsers.name })
          .from(dPosts)
          .innerJoin(dUsers, eq(dPosts.authorId, dUsers.id))
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .innerJoin("users", "posts.authorId", "users.id")
          .select(["posts.id", "posts.title", "users.name"])
          .compile(),
      ),
  },
  {
    name: "insert-values",
    sumak: () =>
      s
        .insertInto("users")
        .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .insert(dUsers)
          .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .insertInto("users")
          .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
          .compile(),
      ),
  },
  {
    name: "update-where",
    sumak: () =>
      s
        .update("users")
        .set({ name: "x" })
        .where(({ id }) => id.eq(1))
        .toSQL(),
    drizzle: () =>
      drizzleToResult(d.update(dUsers).set({ name: "x" }).where(eq(dUsers.id, 1)).toSQL()),
    kysely: () =>
      kyselyToResult(k.updateTable("users").set({ name: "x" }).where("id", "=", 1).compile()),
  },
  {
    name: "delete-where",
    sumak: () =>
      s
        .deleteFrom("users")
        .where(({ id }) => id.eq(1))
        .toSQL(),
    drizzle: () => drizzleToResult(d.delete(dUsers).where(eq(dUsers.id, 1)).toSQL()),
    kysely: () => kyselyToResult(k.deleteFrom("users").where("id", "=", 1).compile()),
  },

  // ──────────────────────────────────────────────────────────────────
  // Extended scenarios — cover boolean composition, IN-lists, ordering,
  // aggregates, multi-table joins, subqueries, and bulk inserts. Each
  // shape stresses a different part of the compile pipeline.
  // ──────────────────────────────────────────────────────────────────

  {
    name: "select-where-or",
    sumak: () =>
      s
        .selectFrom("users")
        .select("id", "name")
        .where(({ id, name }) => sor(id.eq(1), name.eq("ada")))
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ id: dUsers.id, name: dUsers.name })
          .from(dUsers)
          .where(drizzleOr(eq(dUsers.id, 1), eq(dUsers.name, "ada")))
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select(["id", "name"])
          .where(({ eb, or }) => or([eb("id", "=", 1), eb("name", "=", "ada")]))
          .compile(),
      ),
  },
  {
    name: "select-where-in-small",
    sumak: () =>
      s
        .selectFrom("users")
        .selectAll()
        .where(({ id }) => id.in([1, 2, 3, 4, 5]))
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select()
          .from(dUsers)
          .where(inArray(dUsers.id, [1, 2, 3, 4, 5]))
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k.selectFrom("users").selectAll().where("id", "in", [1, 2, 3, 4, 5]).compile(),
      ),
  },
  {
    name: "select-where-in-large",
    sumak: () =>
      s
        .selectFrom("users")
        .selectAll()
        .where(({ id }) => id.in(IDS_100))
        .toSQL(),
    drizzle: () =>
      drizzleToResult(d.select().from(dUsers).where(inArray(dUsers.id, IDS_100)).toSQL()),
    kysely: () =>
      kyselyToResult(k.selectFrom("users").selectAll().where("id", "in", IDS_100).compile()),
  },
  {
    name: "select-order-limit",
    sumak: () =>
      s.selectFrom("users").selectAll().orderBy("name", "ASC").limit(10).offset(20).toSQL(),
    drizzle: () =>
      drizzleToResult(d.select().from(dUsers).orderBy(dUsers.name).limit(10).offset(20).toSQL()),
    kysely: () =>
      kyselyToResult(
        k.selectFrom("users").selectAll().orderBy("name", "asc").limit(10).offset(20).compile(),
      ),
  },
  {
    name: "select-aggregate",
    sumak: () =>
      s
        .selectFrom("users")
        .select({
          total: scount(),
          highestId: smax(typedCol<number>("id")),
          avgId: savg(typedCol<number>("id")),
        })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ total: count(), highestId: max(dUsers.id), avgId: avg(dUsers.id) })
          .from(dUsers)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select((eb) => [
            eb.fn.countAll().as("total"),
            eb.fn.max("id").as("highestId"),
            eb.fn.avg("id").as("avgId"),
          ])
          .compile(),
      ),
  },
  {
    name: "select-group-having",
    sumak: () =>
      s
        .selectFrom("posts")
        .select("authorId")
        .select({ total: scount() })
        .groupBy("authorId")
        .having(({ authorId }) => authorId.gt(0))
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ authorId: dPosts.authorId, total: count() })
          .from(dPosts)
          .groupBy(dPosts.authorId)
          .having(gt(dPosts.authorId, 0))
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select((eb) => ["authorId" as const, eb.fn.countAll().as("total")])
          .groupBy("authorId")
          .having("authorId", ">", 0)
          .compile(),
      ),
  },
  {
    name: "select-distinct",
    sumak: () => s.selectFrom("users").distinct().select("name").toSQL(),
    drizzle: () => drizzleToResult(d.selectDistinct({ name: dUsers.name }).from(dUsers).toSQL()),
    kysely: () => kyselyToResult(k.selectFrom("users").select("name").distinct().compile()),
  },
  {
    name: "left-join-3-tables",
    sumak: () =>
      s
        .selectFrom("comments")
        .leftJoin("posts", ({ comments, posts }) => comments.postId.eq(posts.id))
        .leftJoin("users", ({ comments, users }) => comments.authorId.eq(users.id))
        .select("comments.id", "posts.title", "users.name")
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ id: dComments.id, title: dPosts.title, name: dUsers.name })
          .from(dComments)
          .leftJoin(dPosts, eq(dComments.postId, dPosts.id))
          .leftJoin(dUsers, eq(dComments.authorId, dUsers.id))
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("comments")
          .leftJoin("posts", "comments.postId", "posts.id")
          .leftJoin("users", "comments.authorId", "users.id")
          .select(["comments.id", "posts.title", "users.name"])
          .compile(),
      ),
  },
  {
    name: "select-subquery-in",
    sumak: () => {
      const active = s
        .selectFrom("users")
        .select("id")
        .where(({ id }) => id.gt(0))
        .build()
      return s
        .selectFrom("posts")
        .selectAll()
        .where(({ authorId }) => authorId.in(active))
        .toSQL()
    },
    drizzle: () =>
      drizzleToResult(
        d
          .select()
          .from(dPosts)
          .where(
            inArray(
              dPosts.authorId,
              d.select({ id: dUsers.id }).from(dUsers).where(gt(dUsers.id, 0)),
            ),
          )
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .selectAll()
          .where("authorId", "in", k.selectFrom("users").select("id").where("id", ">", 0))
          .compile(),
      ),
  },
  {
    name: "insert-many-100",
    sumak: () => s.insertInto("users").valuesMany(INSERT_MANY_ROWS).toSQL(),
    drizzle: () => drizzleToResult(d.insert(dUsers).values(INSERT_MANY_ROWS).toSQL()),
    kysely: () => kyselyToResult(k.insertInto("users").values(INSERT_MANY_ROWS).compile()),
  },
  {
    name: "select-where-deep-and",
    sumak: () =>
      s
        .selectFrom("posts")
        .selectAll()
        .where(({ authorId, published, title, body, id }) =>
          sand(authorId.eq(1), published.gt(0), title.neq(""), body.neq(""), id.gt(0)),
        )
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select()
          .from(dPosts)
          .where(
            and(
              eq(dPosts.authorId, 1),
              gt(dPosts.published, 0),
              ne(dPosts.title, ""),
              ne(dPosts.body, ""),
              gt(dPosts.id, 0),
            ),
          )
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .selectAll()
          .where("authorId", "=", 1)
          .where("published", ">", 0)
          .where("title", "<>", "")
          .where("body", "<>", "")
          .where("id", ">", 0)
          .compile(),
      ),
  },
  {
    name: "select-order-desc-limit",
    sumak: () => s.selectFrom("posts").selectAll().orderBy("published", "DESC").limit(20).toSQL(),
    drizzle: () =>
      drizzleToResult(d.select().from(dPosts).orderBy(desc(dPosts.published)).limit(20).toSQL()),
    kysely: () =>
      kyselyToResult(
        k.selectFrom("posts").selectAll().orderBy("published", "desc").limit(20).compile(),
      ),
  },
]
