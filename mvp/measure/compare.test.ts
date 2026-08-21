import { writeFileSync } from "node:fs"

import { and as dAnd, eq as dEq, gt as dGt, ne as dNe } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pg-proxy"
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely"
import { it } from "vitest"

import { posts as dPosts, users as dUsers } from "../../bench/src/schema-drizzle.ts"
import type { BenchDatabase } from "../../bench/src/schema-kysely.ts"
import { tables } from "../../bench/src/schema-sumak.ts"
import { and as sAnd } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { sumak } from "../../src/sumak.ts"
import type { Prepared } from "../index.ts"
import { and as mAnd, db, int, t, text, ts } from "../index.ts"

const s = sumak({ dialect: pgDialect(), tables })

const dz = drizzle(async () => ({ rows: [] }))

const k = new Kysely<BenchDatabase>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (x) => new PostgresIntrospector(x),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

const m = db({
  users: { id: int(), name: text(), email: text(), createdAt: ts() },
  posts: { id: int(), authorId: int(), title: text(), body: text(), published: int() },
})

const mSelectAll = m.from("users").build()
const mWhereEq = m
  .from("users")
  .params(t.num)
  .pick("id", "name")
  .where((c, [id]) => c.users.id.eq(id))
  .build()
const mJoin = m
  .from("posts")
  .pick("id", "title")
  .join("users", (c) => c.posts.authorId.eq(c.users.id))
  .build()
const mDeepAnd = m
  .from("posts")
  .params(t.num, t.num, t.text, t.text, t.num)
  .where((c, [a, b, c2, d2, e2]) =>
    mAnd(
      c.posts.authorId.eq(a),
      c.posts.published.gt(b),
      c.posts.title.neq(c2),
      c.posts.body.neq(d2),
      c.posts.id.gt(e2),
    ),
  )
  .build()
const mUpdate = m
  .update("users")
  .params(t.text, t.num)
  .set(([name]) => ({ name }))
  .where((c, [, id]) => c.users.id.eq(id))
  .build()

const scenarios = [
  {
    name: "select-all",
    sumak: () => s.selectFrom("users").selectAll().toSQL(),
    kysely: () => k.selectFrom("users").selectAll().compile(),
    drizzle: () => dz.select().from(dUsers).toSQL(),
    mvp: mSelectAll as unknown as Prepared<readonly unknown[], unknown>,
    args: [] as unknown[],
  },
  {
    name: "select-where-eq",
    sumak: () =>
      s
        .selectFrom("users")
        .select("id", "name")
        .where(({ id }) => id.eq(1))
        .toSQL(),
    kysely: () => k.selectFrom("users").select(["id", "name"]).where("id", "=", 1).compile(),
    drizzle: () =>
      dz.select({ id: dUsers.id, name: dUsers.name }).from(dUsers).where(dEq(dUsers.id, 1)).toSQL(),
    mvp: mWhereEq as unknown as Prepared<readonly unknown[], unknown>,
    args: [1] as unknown[],
  },
  {
    name: "join-2-tables",
    sumak: () =>
      s
        .selectFrom("posts")
        .innerJoin("users", ({ posts, users }) => posts.authorId.eq(users.id))
        .select("posts.id", "posts.title")
        .toSQL(),
    kysely: () =>
      k
        .selectFrom("posts")
        .innerJoin("users", "posts.authorId", "users.id")
        .select(["posts.id", "posts.title"])
        .compile(),
    drizzle: () =>
      dz
        .select({ id: dPosts.id, title: dPosts.title })
        .from(dPosts)
        .innerJoin(dUsers, dEq(dPosts.authorId, dUsers.id))
        .toSQL(),
    mvp: mJoin as unknown as Prepared<readonly unknown[], unknown>,
    args: [] as unknown[],
  },
  {
    name: "select-where-deep-and",
    sumak: () =>
      s
        .selectFrom("posts")
        .selectAll()
        .where(({ authorId, published, title, body, id }) =>
          sAnd(authorId.eq(1), published.gt(0), title.neq(""), body.neq(""), id.gt(0)),
        )
        .toSQL(),
    kysely: () =>
      k
        .selectFrom("posts")
        .selectAll()
        .where((eb) =>
          eb.and([
            eb("authorId", "=", 1),
            eb("published", ">", 0),
            eb("title", "!=", ""),
            eb("body", "!=", ""),
            eb("id", ">", 0),
          ]),
        )
        .compile(),
    drizzle: () =>
      dz
        .select()
        .from(dPosts)
        .where(
          dAnd(
            dEq(dPosts.authorId, 1),
            dGt(dPosts.published, 0),
            dNe(dPosts.title, ""),
            dNe(dPosts.body, ""),
            dGt(dPosts.id, 0),
          ),
        )
        .toSQL(),
    mvp: mDeepAnd as unknown as Prepared<readonly unknown[], unknown>,
    args: [1, 0, "", "", 0] as unknown[],
  },
  {
    name: "update-where",
    sumak: () =>
      s
        .update("users")
        .set({ name: "x" })
        .where(({ id }) => id.eq(1))
        .toSQL(),
    kysely: () => k.updateTable("users").set({ name: "x" }).where("id", "=", 1).compile(),
    drizzle: () => dz.update(dUsers).set({ name: "x" }).where(dEq(dUsers.id, 1)).toSQL(),
    mvp: mUpdate as unknown as Prepared<readonly unknown[], unknown>,
    args: ["x", 1] as unknown[],
  },
] as const

let sink = 0
function driver(sql: string, params: readonly unknown[]): void {
  sink += sql.length + params.length
}

function time(fn: () => void, iters = 300_000): number {
  for (let i = 0; i < 30_000; i++) fn()
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < iters; i++) fn()
  return Number(process.hrtime.bigint() - t0) / iters
}

it("what a request pays to reach the driver", () => {
  const lines: string[] = []
  lines.push(
    "senaryo".padEnd(24) +
      "drizzle".padStart(10) +
      "kysely".padStart(10) +
      "sumak".padStart(10) +
      "mvp".padStart(9) +
      "mvp+dizi".padStart(10) +
      "mvp-bindsiz".padStart(11),
  )
  lines.push("-".repeat(84))

  for (const sc of scenarios) {
    const tD = time(() => {
      const c = sc.drizzle() as { sql: string; params: unknown[] }
      driver(c.sql, c.params)
    })
    const tK = time(() => {
      const c = sc.kysely() as { sql: string; parameters: readonly unknown[] }
      driver(c.sql, c.parameters)
    })
    const tS = time(() => {
      const c = sc.sumak() as { sql: string; params: readonly unknown[] }
      driver(c.sql, c.params)
    })
    const args = sc.args
    const q = sc.mvp
    const tM = time(() => {
      driver(q.sql, q.bind(args))
    })
    const [a, b, c2, d2, e2] = args
    const tMA = time(() => {
      const fresh =
        args.length === 0
          ? EMPTY
          : args.length === 2
            ? [a, b]
            : args.length === 1
              ? [a]
              : [a, b, c2, d2, e2]
      driver(q.sql, q.bind(fresh))
    })

    lines.push(
      sc.name.padEnd(24) +
        `${tD.toFixed(0)}ns`.padStart(10) +
        `${tK.toFixed(0)}ns`.padStart(10) +
        `${tS.toFixed(0)}ns`.padStart(10) +
        `${tM.toFixed(1)}ns`.padStart(9) +
        `${tMA.toFixed(1)}ns`.padStart(10) +
        `${time(() => driver(q.sql, args)).toFixed(1)}ns`.padStart(11),
    )
  }

  const floorSql = mWhereEq.sql
  const floorArgs: unknown[] = [1]
  const tFloor = time(() => {
    driver(floorSql, floorArgs)
  })
  lines.push("-".repeat(84))
  lines.push(
    "taban (kutuphane yok)".padEnd(24) +
      "-".padStart(10) +
      "-".padStart(10) +
      "-".padStart(10) +
      "-".padStart(9) +
      "-".padStart(10) +
      `${tFloor.toFixed(1)}ns`.padStart(11),
  )

  lines.push("")
  lines.push("mvp bind kimlik fonksiyonu mu (dizi kopyalanmiyor mu):")
  for (const sc of scenarios) {
    lines.push(
      `  ${sc.name.padEnd(24)} direct=${sc.mvp.direct}  bind(args)===args: ${sc.mvp.bind(sc.args) === sc.args}`,
    )
  }

  lines.push("")
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 1000; i++) {
    m.from("users")
      .params(t.num)
      .pick("id", "name")
      .where((c, [id]) => c.users.id.eq(id))
      .build()
  }
  lines.push(
    `kurulum, bir kez: ${(Number(process.hrtime.bigint() - t0) / 1000).toFixed(0)}ns/sorgu`,
  )

  lines.push("")
  lines.push("uretilen SQL — ayni isi mi yapiyorlar:")
  for (const sc of scenarios) {
    const su = sc.sumak() as { sql: string; params: readonly unknown[] }
    const ky = sc.kysely() as { sql: string; parameters: readonly unknown[] }
    lines.push(`  [${sc.name}]`)
    lines.push(`    kysely: ${ky.sql}  ${JSON.stringify(ky.parameters)}`)
    lines.push(`    sumak : ${su.sql}  ${JSON.stringify(su.params)}`)
    lines.push(`    mvp   : ${sc.mvp.sql}  ${JSON.stringify(sc.mvp.bind(sc.args))}`)
  }

  lines.push("")
  lines.push(`(sink=${sink})`)
  const out = lines.join("\n")
  writeFileSync("mvp/measure/RESULTS.txt", `${out}\n`)
}, 600_000)

const EMPTY: unknown[] = []
