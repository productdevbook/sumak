import {
  and,
  avg,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  inArray,
  max,
  ne,
  or as drizzleOr,
  sql as drizzleSql,
} from "drizzle-orm"
import { drizzle } from "drizzle-orm/pg-proxy"
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql as kSql,
} from "kysely"

import { typedCol, typedGt, typedLit } from "../../src/ast/typed-expression.ts"
import {
  and as sand,
  anyValue as sanyValue,
  arrayLength as sarrayLength,
  avg as savg,
  case_ as scase,
  coalesce as scoalesce,
  count as scount,
  countDistinct as scountDistinct,
  dateTrunc as sdateTrunc,
  exists as sexists,
  extract as sextract,
  jsonValue as sjsonValue,
  max as smax,
  or as sor,
  over as sover,
  percentileCont as spercentileCont,
  position as sposition,
  power as spower,
  rank as srank,
  regexpReplace as sregexpReplace,
  rowNumber as srowNumber,
  stddev as sstddev,
  subqueryExpr as ssubqueryExpr,
  val as sval,
  withinGroup as swithinGroup,
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
  {
    name: "cte-single",
    sumak: () => {
      const active = s
        .selectFrom("users")
        .select("id", "name")
        .where(({ id }) => id.gt(0))
        .build()
      return s.selectFrom("users").with("active", active).selectAll().toSQL()
    },
    drizzle: () => {
      const active = d.$with("active").as(d.select().from(dUsers).where(gt(dUsers.id, 0)))
      return drizzleToResult(d.with(active).select().from(dUsers).toSQL())
    },
    kysely: () =>
      kyselyToResult(
        k
          .with("active", (qb) => qb.selectFrom("users").select(["id", "name"]).where("id", ">", 0))
          .selectFrom("users")
          .selectAll()
          .compile(),
      ),
  },
  {
    name: "select-union",
    sumak: () => {
      const second = s.selectFrom("users").select("id", "name")
      return s.selectFrom("users").select("id", "name").union(second).toSQL()
    },
    drizzle: () => {
      const q1 = d.select({ id: dUsers.id, name: dUsers.name }).from(dUsers)
      const q2 = d.select({ id: dUsers.id, name: dUsers.name }).from(dUsers)
      return drizzleToResult(q1.union(q2).toSQL())
    },
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select(["id", "name"])
          .union(k.selectFrom("users").select(["id", "name"]))
          .compile(),
      ),
  },
  {
    name: "select-union-all",
    sumak: () => {
      const second = s.selectFrom("users").select("id", "name")
      return s.selectFrom("users").select("id", "name").unionAll(second).toSQL()
    },
    drizzle: () => {
      const q1 = d.select({ id: dUsers.id, name: dUsers.name }).from(dUsers)
      const q2 = d.select({ id: dUsers.id, name: dUsers.name }).from(dUsers)
      return drizzleToResult(q1.unionAll(q2).toSQL())
    },
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select(["id", "name"])
          .unionAll(k.selectFrom("users").select(["id", "name"]))
          .compile(),
      ),
  },
  {
    name: "cte-with-join",
    // CTE plus a join — exercises the full WITH + JOIN compile path.
    sumak: () => {
      const recent = s
        .selectFrom("posts")
        .select("id", "authorId")
        .where(({ published }) => published.gt(0))
        .build()
      return s
        .selectFrom("users")
        .with("recent_posts", recent)
        .innerJoin("recent_posts" as never, ({ users, recent_posts }: never) =>
          users.id.eq(recent_posts.authorId),
        )
        .select("users.id", "users.name")
        .toSQL()
    },
    drizzle: () => {
      const recent = d
        .$with("recent_posts")
        .as(
          d
            .select({ id: dPosts.id, authorId: dPosts.authorId })
            .from(dPosts)
            .where(gt(dPosts.published, 0)),
        )
      return drizzleToResult(
        d
          .with(recent)
          .select({ id: dUsers.id, name: dUsers.name })
          .from(dUsers)
          .innerJoin(recent, eq(dUsers.id, recent.authorId))
          .toSQL(),
      )
    },
    kysely: () =>
      kyselyToResult(
        k
          .with("recent_posts", (qb) =>
            qb.selectFrom("posts").select(["id", "authorId"]).where("published", ">", 0),
          )
          .selectFrom("users")
          .innerJoin("recent_posts" as never, "users.id" as never, "recent_posts.authorId" as never)
          .select(["users.id", "users.name"])
          .compile(),
      ),
  },
  {
    // Window function: ROW_NUMBER() OVER (PARTITION BY authorId ORDER BY id).
    // Common ranking pattern. sumak has a first-class window builder
    // (`over(rowNumber(), ...)`); drizzle and kysely fall back to raw
    // sql templates because their typed APIs don't cover the non-
    // aggregate window functions like `row_number()`. The compile
    // cost is what we're measuring, not API ergonomics.
    name: "select-from-derived",
    // SELECT * FROM (SELECT id, name FROM users WHERE id > 0) AS u
    // Derived table (subquery in FROM). Useful when you want to filter
    // before window functions / GROUP BY but the schema doesn't have
    // a precomputed view.
    sumak: () => {
      const sub = s
        .selectFrom("users")
        .select("id", "name")
        .where(({ id }) => id.gt(0))
      return s.selectFromSubquery(sub, "u").selectAll().toSQL()
    },
    drizzle: () => {
      const sub = d
        .select({ id: dUsers.id, name: dUsers.name })
        .from(dUsers)
        .where(gt(dUsers.id, 0))
        .as("u")
      return drizzleToResult(d.select().from(sub).toSQL())
    },
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom(k.selectFrom("users").select(["id", "name"]).where("id", ">", 0).as("u"))
          .selectAll()
          .compile(),
      ),
  },
  {
    name: "insert-from-select",
    // INSERT INTO users (id, name, email, createdAt) SELECT ... FROM users
    // Common "copy-modify-insert" pattern (e.g. clone a row, populate
    // a backup table). sumak's `.fromSelect(node)` vs drizzle's
    // `db.insert(t).select(qb)` vs kysely's
    // `.insertInto(...).columns(...).expression(...)`.
    sumak: () => {
      const src = s.selectFrom("users").select("id", "name", "email", "createdAt").build()
      return s.insertInto("users").fromSelect(src).toSQL()
    },
    drizzle: () => {
      const src = d
        .select({
          id: dUsers.id,
          name: dUsers.name,
          email: dUsers.email,
          createdAt: dUsers.createdAt,
        })
        .from(dUsers)
      return drizzleToResult(d.insert(dUsers).select(src).toSQL())
    },
    kysely: () =>
      kyselyToResult(
        k
          .insertInto("users")
          .columns(["id", "name", "email", "createdAt"])
          .expression((eb) => eb.selectFrom("users").select(["id", "name", "email", "createdAt"]))
          .compile(),
      ),
  },
  {
    name: "select-coalesce",
    // SELECT id, COALESCE(name, 'unknown') FROM users — null-safe
    // fallback. Three-arg COALESCE is the standard shape; sumak
    // accepts variadic expressions.
    sumak: () =>
      s
        .selectFrom("users")
        .select("id")
        .select({ displayName: scoalesce(typedCol<string | null>("name"), typedLit("unknown")) })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            id: dUsers.id,
            displayName: drizzleSql<string>`COALESCE(${dUsers.name}, 'unknown')`,
          })
          .from(dUsers)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select((eb) => ["id", eb.fn.coalesce("name", eb.val("unknown")).as("displayName")])
          .compile(),
      ),
  },
  {
    name: "select-group-multi-col",
    // GROUP BY authorId, published — two grouping columns. Exercises
    // the GROUP BY array handling in each printer.
    sumak: () =>
      s
        .selectFrom("posts")
        .select("authorId", "published")
        .select({ total: scount() })
        .groupBy("authorId", "published")
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            authorId: dPosts.authorId,
            published: dPosts.published,
            total: count(),
          })
          .from(dPosts)
          .groupBy(dPosts.authorId, dPosts.published)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select((eb) => ["authorId", "published", eb.fn.countAll().as("total")])
          .groupBy(["authorId", "published"])
          .compile(),
      ),
  },
  {
    name: "scalar-subquery-in-select",
    // SELECT id, name, (SELECT COUNT(*) FROM posts) AS total_posts FROM users
    // — non-correlated scalar subquery as a SELECT column. Common
    // "include a top-level aggregate in every row" pattern.
    sumak: () => {
      const inner = s.selectFrom("posts").select({ c: scount() }).build()
      return s
        .selectFrom("users")
        .select("id", "name")
        .select({ totalPosts: ssubqueryExpr<number>(inner) })
        .toSQL()
    },
    drizzle: () => {
      const inner = d.select({ c: count() }).from(dPosts)
      return drizzleToResult(
        d
          .select({ id: dUsers.id, name: dUsers.name, totalPosts: drizzleSql<number>`(${inner})` })
          .from(dUsers)
          .toSQL(),
      )
    },
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select((eb) => [
            "id",
            "name",
            eb.selectFrom("posts").select(eb.fn.countAll().as("c")).as("totalPosts"),
          ])
          .compile(),
      ),
  },
  {
    name: "select-exists-subquery",
    // SELECT … WHERE EXISTS (SELECT 1 FROM posts WHERE posts.author_id = users.id)
    // Correlated subquery — the inner query references the outer
    // table. Every dialect supports EXISTS; sumak uses `exists(node)`,
    // drizzle and kysely both have a typed `exists()` helper.
    sumak: () => {
      const inner = s
        .selectFrom("posts")
        .selectAll()
        .where(({ authorId }) => authorId.gt(0))
        .build()
      return s
        .selectFrom("users")
        .selectAll()
        .where(() => sexists(inner))
        .toSQL()
    },
    drizzle: () => {
      const inner = d.select().from(dPosts).where(gt(dPosts.authorId, 0))
      return drizzleToResult(
        d
          .select()
          .from(dUsers)
          .where(drizzleSql`EXISTS (${inner})`)
          .toSQL(),
      )
    },
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .selectAll()
          .where(({ exists, selectFrom }) =>
            exists(selectFrom("posts").selectAll().where("authorId", ">", 0)),
          )
          .compile(),
      ),
  },
  {
    name: "select-case-when",
    // CASE WHEN published > 0 THEN 'published' ELSE 'draft' END
    // — common categorize-as-you-go pattern. Three branches builds
    // the AST nodes that the printer's `printCase` walks; the bench
    // measures the per-branch dispatch cost.
    sumak: () =>
      s
        .selectFrom("posts")
        .select("id")
        .select({
          status: scase()
            .when(typedGt(typedCol<number>("published"), typedLit(0)), typedLit("published"))
            .else_(typedLit("draft"))
            .end(),
        })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            id: dPosts.id,
            status: drizzleSql<string>`CASE WHEN ${gt(dPosts.published, 0)} THEN 'published' ELSE 'draft' END`,
          })
          .from(dPosts)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select((eb) => [
            "id",
            eb
              .case()
              .when("published", ">", 0)
              .then(eb.val("published"))
              .else(eb.val("draft"))
              .end()
              .as("status"),
          ])
          .compile(),
      ),
  },
  {
    name: "upsert-do-update",
    // INSERT … ON CONFLICT (email) DO UPDATE SET name = excluded.name.
    // The canonical UPSERT shape — every PG / SQLite (3.24+) /
    // MariaDB / MySQL 8.0.19+ (via INSERT … AS ... DUPLICATE KEY) app
    // hits this on a daily basis. sumak builds an OnConflictNode with
    // a target-column list + UPDATE SET map; kysely calls
    // `onConflict(oc => oc.column("email").doUpdateSet(...))`;
    // drizzle uses `onConflictDoUpdate({target, set})`.
    sumak: () =>
      s
        .insertInto("users")
        .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
        .onConflict({ columns: ["email"], do: { update: { name: "ada" } } })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .insert(dUsers)
          .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
          .onConflictDoUpdate({ target: dUsers.email, set: { name: "ada" } })
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .insertInto("users")
          .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
          .onConflict((oc) => oc.column("email").doUpdateSet({ name: "ada" }))
          .compile(),
      ),
  },
  {
    name: "insert-returning",
    // INSERT … RETURNING id, name — common shape for "create-and-return".
    // PG-only standard but kysely + drizzle both support it on PG. The
    // RETURNING clause adds AST nodes after the VALUES; the bench
    // measures how cleanly each library handles that tail.
    sumak: () =>
      s
        .insertInto("users")
        .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
        .returning("id", "name")
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .insert(dUsers)
          .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
          .returning({ id: dUsers.id, name: dUsers.name })
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .insertInto("users")
          .values({ id: 1, name: "ada", email: "ada@x.io", createdAt: new Date(0) })
          .returning(["id", "name"])
          .compile(),
      ),
  },
  {
    name: "window-row-number",
    sumak: () =>
      s
        .selectFrom("posts")
        .select("id", "authorId")
        .select({
          rn: sover(srowNumber(), (w) => w.partitionBy("authorId").orderBy("id")),
        })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            id: dPosts.id,
            authorId: dPosts.authorId,
            rn: drizzleSql<number>`row_number() over (partition by ${dPosts.authorId} order by ${dPosts.id})`,
          })
          .from(dPosts)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select((eb) => [
            "id",
            "authorId",
            eb.fn
              .agg<number>("row_number")
              .over((ob) => ob.partitionBy("authorId" as never).orderBy("id" as never))
              .as("rn"),
          ])
          .compile(),
      ),
  },
  {
    name: "select-count-distinct",
    // SELECT COUNT(DISTINCT authorId) FROM posts — exercises a
    // different printer path than plain COUNT (the DISTINCT keyword
    // is inside the function-call args, not a separate clause).
    // Common in analytics; cheap to express; drizzle and kysely both
    // have first-class shapes for it (no raw-sql fallback needed).
    sumak: () =>
      s
        .selectFrom("posts")
        .select({ uniqueAuthors: scountDistinct(typedCol<number>("authorId")) })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ uniqueAuthors: countDistinct(dPosts.authorId) })
          .from(dPosts)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select((eb) => eb.fn.count<number>("authorId").distinct().as("uniqueAuthors"))
          .compile(),
      ),
  },

  // ──────────────────────────────────────────────────────────────────
  // SQL:2003 / 2011 / 2016 / 2023 features — added in PRs #142–151.
  // Each scenario exercises a printer path that didn't exist in the
  // bench suite before, so we can track compile-cost regressions as
  // the new feature surface evolves. Where competitors have no first-
  // class API (`PERCENTILE_CONT`, named WINDOW, `JSON_VALUE`, `IS
  // JSON`, `ANY_VALUE`, three-branch MERGE), they fall back to raw
  // sql templates — we're measuring compile cost, not API surface
  // ergonomics.
  // ──────────────────────────────────────────────────────────────────

  {
    name: "select-window-rank",
    // RANK() OVER (PARTITION BY authorId ORDER BY id) — sibling of
    // window-row-number but uses RANK, which has different semantics
    // for ties (gaps). Compile path is identical to ROW_NUMBER; this
    // exists so the rank() helper has explicit bench coverage rather
    // than relying on rowNumber() as a stand-in.
    sumak: () =>
      s
        .selectFrom("posts")
        .select("id", "authorId")
        .select({
          rk: sover(srank(), (w) => w.partitionBy("authorId").orderBy("id")),
        })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            id: dPosts.id,
            authorId: dPosts.authorId,
            rk: drizzleSql<number>`rank() over (partition by ${dPosts.authorId} order by ${dPosts.id})`,
          })
          .from(dPosts)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select((eb) => [
            "id",
            "authorId",
            eb.fn
              .agg<number>("rank")
              .over((ob) => ob.partitionBy("authorId" as never).orderBy("id" as never))
              .as("rk"),
          ])
          .compile(),
      ),
  },
  {
    name: "select-percentile",
    // SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY published)
    // FROM posts — SQL:2003 ordered-set aggregate, common dashboard
    // shape. Sumak has first-class `withinGroup(percentileCont(0.5), …)`;
    // kysely and drizzle drop to raw template literals because their
    // typed APIs don't model the WITHIN GROUP clause.
    sumak: () =>
      s
        .selectFrom("posts")
        .select({
          p50: swithinGroup(spercentileCont(0.5), [{ expr: typedCol<number>("published") }]),
        })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            p50: drizzleSql<number>`percentile_cont(0.5) within group (order by ${dPosts.published})`,
          })
          .from(dPosts)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select(
            kSql<number>`percentile_cont(0.5) within group (order by ${kSql.ref("published")})`.as(
              "p50",
            ),
          )
          .compile(),
      ),
  },
  {
    name: "select-named-window",
    // SELECT … OVER w … OVER w FROM posts
    //   WINDOW w AS (PARTITION BY authorId ORDER BY id)
    // SQL:2003 named WINDOW lets two OVER references share a single
    // spec. Sumak has `.window(name, build)` + `over(fn, name)`. Kysely
    // and drizzle have no named-WINDOW surface — both fall back to a
    // raw SELECT-string composition. The compile cost difference is
    // the point: sumak's AST has a dedicated WindowNode and a single
    // emit pass; the raw forms drop their entire payload as a string
    // literal and skip the AST work entirely.
    sumak: () =>
      s
        .selectFrom("posts")
        .window("w", (b) => b.partitionBy("authorId").orderBy("id"))
        .select("id", "authorId")
        .select({
          rn: sover(srowNumber(), "w"),
          rk: sover(srank(), "w"),
        })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            id: dPosts.id,
            authorId: dPosts.authorId,
            rn: drizzleSql<number>`row_number() over w`,
            rk: drizzleSql<number>`rank() over w`,
          })
          .from(dPosts)
          .toSQL(),
      ),
    // Kysely has no public surface for the trailing WINDOW clause so we
    // fall through to a fully-raw query; that's the comparison point.
    kysely: () =>
      kyselyToResult(
        kSql<unknown>`select ${kSql.ref("id")}, ${kSql.ref("authorId")}, row_number() over w as ${kSql.ref("rn")}, rank() over w as ${kSql.ref("rk")} from ${kSql.ref("posts")} window w as (partition by ${kSql.ref("authorId")} order by ${kSql.ref("id")})`.compile(
          k,
        ),
      ),
  },
  {
    name: "select-json-value",
    // SELECT JSON_VALUE(body, '$.path') FROM posts — SQL:2016
    // scalar JSON extraction (PG 17+, MySQL 8, MSSQL). Sumak has a
    // typed `jsonValue(col, path)` helper; competitors use raw sql
    // because they don't model the SQL:2016 function-call surface yet.
    // Path is a literal, not a parameter, in every dialect — that's
    // the spec.
    sumak: () =>
      s
        .selectFrom("posts")
        .select({
          name: sjsonValue(typedCol<unknown>("body"), "$.name") as never,
        })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            name: drizzleSql<string>`JSON_VALUE(${dPosts.body}, '$.name')`,
          })
          .from(dPosts)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select(kSql<string>`JSON_VALUE(${kSql.ref("body")}, '$.name')`.as("name"))
          .compile(),
      ),
  },
  {
    name: "select-is-json",
    // SELECT * FROM posts WHERE body IS JSON — SQL:2016 JSON-validity
    // predicate (PG 16+, MySQL 8, MSSQL). Sumak has a first-class
    // `.isJson()` on column proxies; kysely and drizzle drop to raw
    // SQL because the predicate isn't part of their boolean AST.
    sumak: () =>
      s
        .selectFrom("posts")
        .selectAll()
        .where(({ body }) => body.isJson())
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select()
          .from(dPosts)
          .where(drizzleSql`${dPosts.body} IS JSON`)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .selectAll()
          .where(kSql<boolean>`${kSql.ref("body")} IS JSON`)
          .compile(),
      ),
  },
  {
    name: "select-count-any-value",
    // SELECT authorId, ANY_VALUE(title) FROM posts GROUP BY authorId —
    // SQL:2023 ANY_VALUE aggregate (PG 16+, MySQL 8, SQLite, MSSQL).
    // Replaces the older "GROUP BY then hope the dialect picks
    // something sensible" pattern with an explicit "any row will do"
    // signal. Sumak has a typed `anyValue(expr)` helper; competitors
    // fall back to raw sql.
    sumak: () =>
      s
        .selectFrom("posts")
        .select("authorId")
        .select({ sampleTitle: sanyValue(typedCol<string>("title")) })
        .groupBy("authorId")
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            authorId: dPosts.authorId,
            sampleTitle: drizzleSql<string>`ANY_VALUE(${dPosts.title})`,
          })
          .from(dPosts)
          .groupBy(dPosts.authorId)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select(["authorId", kSql<string>`ANY_VALUE(${kSql.ref("title")})`.as("sampleTitle")])
          .groupBy("authorId")
          .compile(),
      ),
  },
  {
    name: "merge-not-matched-by-source-bench",
    // MERGE INTO users USING comments AS c ON … WHEN MATCHED … WHEN
    // NOT MATCHED … WHEN NOT MATCHED BY SOURCE …
    //
    // SQL:2023 three-branch MERGE — PG 17+ and MSSQL only. Sumak has a
    // typed merge builder with `.whenMatchedThenUpdate()` /
    // `.whenNotMatchedThenInsert()` / `.whenNotMatchedBySourceThenDelete()`.
    // Drizzle has no MERGE support at all; kysely does have native
    // merge methods (#143) but we use raw template literals on both
    // for a fair compile-cost comparison: this scenario measures
    // sumak's typed AST construction vs the competitors' "just emit
    // the string" baseline.
    //
    // The bench cost is dominated by the three WHEN-branch AST nodes
    // — MERGE compile is the heaviest scenario in the suite by a wide
    // margin, expected to land around 30–50k hz vs the 100k+ baseline
    // for simpler scenarios.
    sumak: () =>
      s
        .mergeInto("users", {
          source: "comments",
          alias: "c",
          on: ({ target, source }) => target.id.eq(source.authorId),
        })
        .whenMatchedThenUpdate({ name: "updated" })
        .whenNotMatchedThenInsert({ id: 1, name: "new", email: "new@x.io", createdAt: new Date(0) })
        .whenNotMatchedBySourceThenDelete()
        .toSQL(),
    drizzle: () => {
      // Drizzle has no MERGE — we emit the SQL via the package's
      // own dialect.sqlToQuery() so the params are parameterised the
      // same way drizzle would normally do it. The dialect handle is
      // internal but stable; we type-cast through `any` since the
      // bench is a measurement harness, not a typed consumer.
      const updated = "updated"
      const newName = "new"
      const newEmail = "new@x.io"
      const newId = 1
      const newDate = new Date(0)
      const raw = drizzleSql`MERGE INTO ${dUsers} USING ${dComments} AS "c" ON ${dUsers.id} = ${dComments.authorId} WHEN MATCHED THEN UPDATE SET ${dUsers.name} = ${updated} WHEN NOT MATCHED THEN INSERT (${dUsers.id}, ${dUsers.name}, ${dUsers.email}, ${dUsers.createdAt}) VALUES (${newId}, ${newName}, ${newEmail}, ${newDate}) WHEN NOT MATCHED BY SOURCE THEN DELETE`
      return drizzleToResult(
        (
          d as unknown as {
            dialect: { sqlToQuery(sql: unknown): { sql: string; params: unknown[] } }
          }
        ).dialect.sqlToQuery(raw),
      )
    },
    kysely: () =>
      kyselyToResult(
        kSql<unknown>`MERGE INTO ${kSql.ref("users")} USING ${kSql.ref("comments")} AS ${kSql.ref("c")} ON ${kSql.ref("users.id")} = ${kSql.ref("c.authorId")} WHEN MATCHED THEN UPDATE SET ${kSql.ref("name")} = ${"updated"} WHEN NOT MATCHED THEN INSERT (${kSql.ref("id")}, ${kSql.ref("name")}, ${kSql.ref("email")}, ${kSql.ref("createdAt")}) VALUES (${1}, ${"new"}, ${"new@x.io"}, ${new Date(0)}) WHEN NOT MATCHED BY SOURCE THEN DELETE`.compile(
          k,
        ),
      ),
  },

  // ──────────────────────────────────────────────────────────────────
  // Scalar / aggregate function coverage — features shipped after the
  // previous bench wave (PRs #155, #156, #162, #164, #165, #166).
  // Each scenario exercises a builder that has a dedicated AST shape
  // on sumak's side (validated unit / field, pattern-literal inlining,
  // POSITION-IN keyword form, etc.) while the competitors drop to raw
  // sql templates. The bench measures the compile-cost of sumak's
  // typed path against that raw-template baseline.
  // ──────────────────────────────────────────────────────────────────

  {
    name: "select-regex-replace",
    // SELECT REGEXP_REPLACE("name", '[^a-z]', '', 'g') FROM users — PG /
    // MySQL / SQLite (3.36+). The pattern, replacement, and flags are
    // emitted as inline literals (not parameters) on sumak — same shape
    // a drizzle raw template would produce.
    sumak: () =>
      s
        .selectFrom("users")
        .select({
          clean: sregexpReplace(typedCol<string>("name"), "[^a-z]", "", "g"),
        })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            clean: drizzleSql<string>`REGEXP_REPLACE(${dUsers.name}, '[^a-z]', '', 'g')`,
          })
          .from(dUsers)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select(kSql<string>`REGEXP_REPLACE(${kSql.ref("name")}, '[^a-z]', '', 'g')`.as("clean"))
          .compile(),
      ),
  },
  {
    name: "select-extract-month",
    // SELECT EXTRACT(MONTH FROM "createdAt") FROM users — SQL standard.
    // sumak validates the field against a fixed allowlist and emits the
    // dedicated `extractField` AST shape; competitors fall back to raw
    // since they have no typed surface for the FIELD-FROM-expr grammar.
    sumak: () =>
      s
        .selectFrom("users")
        .select({ m: sextract("month", typedCol<Date>("createdAt")) })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ m: drizzleSql<number>`EXTRACT(MONTH FROM ${dUsers.createdAt})` })
          .from(dUsers)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select(kSql<number>`EXTRACT(MONTH FROM ${kSql.ref("createdAt")})`.as("m"))
          .compile(),
      ),
  },
  {
    name: "select-date-trunc",
    // SELECT DATE_TRUNC('day', "createdAt") FROM users — PG-only standard
    // for rounding a timestamp down to a calendar unit. sumak validates
    // the unit against an identifier regex and inlines it as a literal;
    // competitors emit raw.
    sumak: () =>
      s
        .selectFrom("users")
        .select({ bucket: sdateTrunc("day", typedCol<Date>("createdAt")) })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ bucket: drizzleSql<Date>`DATE_TRUNC('day', ${dUsers.createdAt})` })
          .from(dUsers)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select(kSql<Date>`DATE_TRUNC('day', ${kSql.ref("createdAt")})`.as("bucket"))
          .compile(),
      ),
  },
  {
    name: "select-stddev-group",
    // SELECT "authorId", STDDEV("published") FROM posts GROUP BY "authorId"
    // — sample standard deviation per group. PG / MySQL / SQLite expose
    // it under the SQL-standard name. sumak has a first-class
    // `stddev(expr)` aggregate; competitors fall back to raw because
    // their typed `fn.*` namespaces don't catalogue the dispersion
    // family. Pairs aggregation + GROUP BY, which is the realistic
    // shape this function appears in.
    sumak: () =>
      s
        .selectFrom("posts")
        .select("authorId")
        .select({ jitter: sstddev(typedCol<number>("published")) })
        .groupBy("authorId")
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({
            authorId: dPosts.authorId,
            jitter: drizzleSql<number>`STDDEV(${dPosts.published})`,
          })
          .from(dPosts)
          .groupBy(dPosts.authorId)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select(["authorId", kSql<number>`STDDEV(${kSql.ref("published")})`.as("jitter")])
          .groupBy("authorId")
          .compile(),
      ),
  },
  {
    name: "select-position",
    // SELECT POSITION($1 IN "email") FROM users — SQL standard 1-based
    // substring search. sumak emits the IN-keyword form via a dedicated
    // `isPositionCall` flag on the FunctionCallNode so the printer
    // chooses POSITION-IN vs the MSSQL CHARINDEX rewrite. Competitors
    // have no typed surface for POSITION's special grammar so they
    // raw-template; the bench measures sumak's typed AST against that
    // raw baseline.
    sumak: () =>
      s
        .selectFrom("users")
        .select({ atIdx: sposition(sval("@"), typedCol<string>("email")) })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ atIdx: drizzleSql<number>`POSITION('@' IN ${dUsers.email})` })
          .from(dUsers)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("users")
          .select(kSql<number>`POSITION('@' IN ${kSql.ref("email")})`.as("atIdx"))
          .compile(),
      ),
  },
  {
    name: "select-array-length",
    // SELECT array_length("body", 1) FROM posts — PG array-family helper.
    // The schema's "body" is text, not an array, but the bench only
    // measures compile cost (not exec), and `typedCol<string[]>` makes
    // the printer treat it as an array reference; the produced SQL is
    // valid PG syntax regardless. Competitors fall back to raw since
    // they have no typed array-builder surface.
    sumak: () =>
      s
        .selectFrom("posts")
        .select({ tagCount: sarrayLength(typedCol<string[]>("body")) })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ tagCount: drizzleSql<number>`array_length(${dPosts.body}, 1)` })
          .from(dPosts)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select(kSql<number>`array_length(${kSql.ref("body")}, 1)`.as("tagCount"))
          .compile(),
      ),
  },
  {
    name: "select-power",
    // SELECT POWER("published", $1) FROM posts — exponentiation. PG /
    // MySQL / SQLite / MSSQL all accept the POWER spelling. sumak builds
    // a plain function-call AST; competitors raw-template (drizzle has
    // no typed math helpers; kysely's `fn` doesn't include POWER as a
    // first-class shape).
    sumak: () =>
      s
        .selectFrom("posts")
        .select({ sq: spower(typedCol<number>("published"), sval(2)) })
        .toSQL(),
    drizzle: () =>
      drizzleToResult(
        d
          .select({ sq: drizzleSql<number>`POWER(${dPosts.published}, ${2})` })
          .from(dPosts)
          .toSQL(),
      ),
    kysely: () =>
      kyselyToResult(
        k
          .selectFrom("posts")
          .select(kSql<number>`POWER(${kSql.ref("published")}, ${2})`.as("sq"))
          .compile(),
      ),
  },
]
