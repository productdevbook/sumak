import { and, eq, gt } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pg-proxy"
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely"

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

export const scenarios: Scenario[] = [
  {
    name: "select-all",
    sumak: () => s.selectFrom("users").selectAll().toSQL(),
    drizzle: () => drizzleToResult(d.select().from(dUsers).toSQL()),
    kysely: () => kyselyToResult(k.selectFrom("users").selectAll().compile()),
  },
  {
    name: "select-where-eq",
    sumak: () => s.selectFrom("users").select("id", "name").where("id", "=", 42).toSQL(),
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
        .where("authorId", "=", 7)
        .where("published", ">", 0)
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
    sumak: () => s.update("users").set({ name: "x" }).where("id", "=", 1).toSQL(),
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
]
