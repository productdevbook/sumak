# Migrating to sumak from kysely or drizzle

sumak deliberately mirrors patterns from both: the typed-callback builder
shape comes from **kysely**, the schema-as-code column factories come from
**drizzle**. Most ports are cosmetic — rename a few imports, swap a couple
of method names, keep the rest.

Task-oriented guide: side-by-side snippets for real-world patterns, plus a
short list of sumak-specific features. Throughput numbers live in
[`bench/README.md`](../bench/README.md).

---

## 1. Quick comparison table

| Pattern               | kysely                                                                | drizzle                                                      | sumak                                                                   |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Schema definition     | `interface DB { users: { id: number; … } }` (hand-rolled types)       | `pgTable("users", { id: serial("id").primaryKey(), … })`     | `sumak({ tables: { users: { id: serial().primaryKey(), … } } })`        |
| Connect / build SQL   | `new Kysely({ dialect: new PostgresDialect({ pool }) })`              | `drizzle(pool)`                                              | `sumak({ dialect: pgDialect(), driver, tables })`                       |
| SELECT basics         | `db.selectFrom("u").select(["id", "name"]).execute()`                 | `db.select({ id, name }).from(users)`                        | `db.selectFrom("users").select("id", "name").many()`                    |
| WHERE callback        | `.where((eb) => eb("age", ">", 18))` / 3-arg `.where("age", ">", 18)` | `.where(gt(users.age, 18))` (flat helper)                    | `.where(({ age }) => age.gt(18))` / 3-arg `.where("age", ">", 18)`      |
| INNER JOIN            | `.innerJoin("p", "p.userId", "u.id")`                                 | `.innerJoin(posts, eq(posts.userId, users.id))`              | `.innerJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))`  |
| INSERT                | `.insertInto("u").values(row).execute()`                              | `db.insert(users).values(row)`                               | `db.insertInto("users").values(row).exec()`                             |
| UPDATE                | `.updateTable("u").set({ … }).where(…).execute()`                     | `db.update(users).set({ … }).where(…)`                       | `db.update("users").set({ … }).where(…).exec()`                         |
| DELETE                | `.deleteFrom("u").where(…).execute()`                                 | `db.delete(users).where(…)`                                  | `db.deleteFrom("users").where(…).exec()`                                |
| COUNT(\*)             | `db.fn.countAll()` / `db.fn.count('id')`                              | `count()` / `count(users.id)`                                | `count()` / `count(typedCol("id"))`                                     |
| COUNT(DISTINCT col)   | `db.fn.count('col').distinct()`                                       | `countDistinct(users.col)`                                   | `countDistinct(typedCol("col"))`                                        |
| Window — `ROW_NUMBER` | `eb.fn.agg("row_number").over(w => w.partitionBy("d").orderBy("s"))`  | `sql\`row_number() over (partition by ${d} order by ${s})\`` | `over(rowNumber(), w => w.partitionBy("d").orderBy("s"))`               |
| CTE                   | `.with("active", (eb) => eb.selectFrom(...)).selectFrom("active")`    | `db.with("active", db.$with(...))` (limited)                 | `db.selectFrom("users").with("active", subq)`                           |
| WITH RECURSIVE        | `.withRecursive("tree", …)`                                           | `db.execute(sql\`WITH RECURSIVE …\`)` (raw)                  | `.with("tree", subq, { recursive: true })`                              |
| Transaction           | `db.transaction().execute(async (tx) => { … })`                       | `db.transaction(async (tx) => { … })`                        | `db.transaction(async (tx) => { … })`                                   |
| Compile vs execute    | `.compile()` returns `{ sql, parameters }`; `.execute()` runs it      | implicit — driver compiles on the fly                        | `.toSQL()` returns `{ sql, params }`; `.many/.one/.first/.exec` runs    |
| Raw SQL               | `sql\`SELECT … ${val}\``                                              | `sql\`SELECT … ${val}\``                                     | `sql\`SELECT … ${val}\`` (same tag, same auto-param semantics)          |
| Row inference         | `Selectable<DB["users"]>` / `Insertable<…>` / `Updateable<…>`         | `InferSelectModel<typeof users>` / `InferInsertModel<…>`     | both work — `Selectable<…>` and `InferSelectModel<…>` are both exported |
| Pre-baked queries     | `.compile()` returns a fixed `{ sql, parameters }`                    | prepared statements via `.prepare("name")` + `placeholder`   | `.toCompiled<P>()` returns a function that re-fills placeholders        |

---

## 2. Coming from kysely

Three changes carry most of the port:

1. Instance built from `sumak({ … })` instead of `new Kysely(…)`.
2. Schema is runtime column factories, not a hand-rolled `DB` interface
   — the type is inferred.
3. `.execute()` splits into `.many()` / `.one()` / `.first()` / `.exec()`,
   matching the cardinality the caller expects.

### Schema definition

```ts
// kysely — types only, runtime DB is your own DDL
interface DB {
  users: { id: Generated<number>; name: string; email: string; age: number | null }
  posts: { id: Generated<number>; title: string; userId: number }
}
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
```

```ts
// sumak — types + DDL out of the same source
import { sumak, pgDialect, serial, text, integer } from "sumak"

const db = sumak({
  dialect: pgDialect(),
  driver,
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer().nullable(),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      userId: integer().references("users", "id"),
    },
  },
})
```

The `tables` map drives the typed-builder generics **and** the
`db.generateDDL()` / `diffSchemas()` / `introspect()` surfaces.

### `.where("col", "op", val)`

PR #99 added the kysely three-arg form. Same operator strings, same AST:

```ts
db.selectFrom("users").where("age", "=", 25)
db.selectFrom("users").where("name", "ilike", "%alice%")
db.selectFrom("users").where("id", "in", [1, 2, 3])
db.selectFrom("users").where("deleted_at", "is", null)
```

The RHS type is narrowed per operator — `like` only accepts a string,
`in` only an array, `is`/`is not` only `null`. Typos like
`.where("name", "like", 42)` are compile-time errors.

Reach for the callback form when you need boolean combinators or
column-to-column comparisons:

```ts
import { and } from "sumak"

db.selectFrom("users").where(({ age, active }) => and(age.gt(18), active.eq(true)))
```

### Aggregates — `countDistinct` etc.

```ts
// kysely — chained .distinct() on the typed function namespace
db.selectFrom("orders").select(db.fn.count("customer_id").distinct().as("c"))
```

```ts
// sumak — dedicated countDistinct / sumDistinct / avgDistinct
import { countDistinct, typedCol } from "sumak"

db.selectFrom("orders").select({
  c: countDistinct(typedCol("customer_id")),
})
```

`typedCol<T>("col")` is the explicit way to produce an `Expression<T>`
outside a `.where()` callback. Inside `.where()` you keep using the
column proxy: `({ customer_id }) => …`.

### Window functions

```ts
// kysely
db.selectFrom("employees").select((eb) => [
  "id",
  eb.fn
    .agg<number>("row_number")
    .over((w) => w.partitionBy("dept").orderBy("salary", "desc"))
    .as("rn"),
])
```

```ts
// sumak — named window functions + shared over(...)
import { over, rowNumber } from "sumak"

db.selectFrom("employees")
  .select("id")
  .select({ rn: over(rowNumber(), (w) => w.partitionBy("dept").orderBy("salary", "DESC")) })
```

Also exported: `rank`, `denseRank`, `lag`, `lead`, `ntile`, `firstValue`,
`lastValue`, `nthValue`. Frames:

```ts
import { over, sum, typedCol } from "sumak"

over(sum(typedCol<number>("amount")), (w) =>
  w
    .partitionBy("userId")
    .orderBy("createdAt")
    .rows({ type: "unbounded_preceding" }, { type: "current_row" }),
)
```

### CTEs (`with` / `withRecursive`)

sumak collapses the recursive variant into an option on `.with()`:

```ts
// kysely
db.with("active", (eb) => eb.selectFrom("users").where("active", "=", true))
  .selectFrom("active")
  .selectAll()

db.withRecursive("tree", (eb) => /* ... */ )
```

```ts
// sumak
const active = db.selectFrom("users").where(({ active }) => active.eq(true))

db.selectFrom("users").with("active", active).selectAll()
db.selectFrom("categories").with("tree", recursiveQuery, { recursive: true })
```

`.with()` accepts either a builder (preferred) or a raw `SelectNode` from
`builder.build()`. Available on `selectFrom`, `insertInto`, `update`,
`deleteFrom`, `mergeInto`.

### `compile` vs `execute`

kysely splits SQL generation from execution via `.compile()` and
`.execute()`. sumak has the same split, named after intent:

| kysely                             | sumak                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| `qb.compile()` → `{ sql, params }` | `qb.toSQL()` → `{ sql, params }`                            |
| `qb.execute()` → `Row[]`           | `qb.many()` → `Row[]`                                       |
| `qb.executeTakeFirst()` → `Row?`   | `qb.first()` → `Row \| null`                                |
| `qb.executeTakeFirstOrThrow()`     | `qb.one()` → throws `UnexpectedRowCountError` if `≠1`       |
| (no direct equivalent)             | `qb.exec()` → `{ affected }` for writes without `RETURNING` |

Pre-baked path — kysely returns a fixed `{ sql, parameters }` from
`.compile()`; sumak returns a function via `.toCompiled<P>()`:

```ts
import { placeholder } from "sumak"

const findUser = db
  .selectFrom("users")
  .where(({ id }) => id.eq(placeholder("id")))
  .toCompiled<{ id: number }>()

findUser({ id: 42 }) // → { sql, params: [42] }
findUser.sql // pre-baked SQL string
```

Available on `SELECT`/`INSERT`/`UPDATE`/`DELETE`. Functional shape:
`compileQuery(builder.build(), db.printer())`.

---

## 3. Coming from drizzle

Three differences shape the port:

1. drizzle's flat helpers (`eq`, `gt`, `count`, …) become method-style
   calls on the column proxy inside `.where(...)`. Flat helpers (`count`,
   `coalesce`, `and`, `or`, …) still exist for `.select({ … })` projections.
2. No relational `db.query.users.findMany(…)` API — sumak ships only the
   explicit typed-select builder. Joins are written explicitly.
3. drizzle's `pgTable(name, { … })` becomes either a raw map under
   `tables: { users: { … } }` or `defineTable("users", { … })` when you
   need constraints / indexes options.

### Schema definition

```ts
// drizzle
import { pgTable, serial, text, integer, boolean } from "drizzle-orm/pg-core"

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  age: integer("age"),
  active: boolean("active").default(true),
})
```

```ts
// sumak
import { sumak, pgDialect, serial, text, integer, boolean } from "sumak"

const db = sumak({
  dialect: pgDialect(),
  driver,
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer().nullable(),
      active: boolean().defaultTo(true),
    },
  },
})
```

Factories line up 1:1 with drizzle's `pg-core`: `serial`, `text`,
`integer`, `boolean`, `varchar`, `bigint`, `bigserial`, `numeric`,
`real`, `doublePrecision`, `timestamp`, `timestamptz`, `date`, `time`,
`interval`, `uuid`, `json`, `jsonb`, `char`, `bytea`, `enumType`,
`smallint`. Modifiers: `.primaryKey()`, `.notNull()`, `.nullable()`,
`.unique()`, `.defaultTo(...)`, `.references("users", "id")`.

For composite constraints / indexes, wrap with
`defineTable("name", { … }, { constraints, indexes })`.

### Filters — flat helpers vs the column proxy

```ts
// drizzle
import { eq, gt, and, count } from "drizzle-orm"

await db
  .select({ count: count() })
  .from(users)
  .where(and(eq(users.active, true), gt(users.age, 18)))
```

```ts
// sumak — operators as methods on the column proxy
import { and, count } from "sumak"

await db
  .selectFrom("users")
  .select({ count: count() })
  .where(({ active, age }) => and(active.eq(true), age.gt(18)))
  .many()
```

`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `between`, `isNull`, `in`
all live as methods on the `Col<T>` proxy. `and` / `or` / `not` are
top-level imports.

### `sql` tagged template

Same tagged-template syntax on both sides:

```ts
// drizzle
import { sql } from "drizzle-orm"
db.select()
  .from(users)
  .where(sql`${users.email} ILIKE ${pattern}`)
```

```ts
// sumak
import { sql } from "sumak"
db.selectFrom("users").where(() => sql`${sql.ref("email")} ILIKE ${pattern}`)
```

Both inline `Expression` operands and parameterize primitives. sumak
adds `sql.ref("id")` (quotes an identifier) and `sql.table("users",
"public")` (schema-qualified table) under the same namespace.

For pure expression composition without interpolation, the typed
`Expression<T>` factories are a better fit:

```ts
import { typedCol, typedEq, typedParam } from "sumak"

const pred = typedEq(typedCol<number>("id"), typedParam(0, 42))
db.selectFrom("users").where(() => pred)
```

### Row inference

`InferSelectModel` / `InferInsertModel` are re-exported under the same
names in sumak (PR #107), backed internally by sumak's existing
`Selectable<T>` / `Insertable<T>` / `Updateable<T>`:

```ts
import type { InferSelectModel, InferInsertModel, InferUpdateModel } from "sumak"

const tables = { users: { id: serial().primaryKey(), name: text().notNull() } }

type User = InferSelectModel<typeof tables.users>
type NewUser = InferInsertModel<typeof tables.users>
type UserUpdate = InferUpdateModel<typeof tables.users>
```

`InferSelectModel` respects nullability (`T | null`, never `T |
undefined`). `InferInsertModel` makes columns with defaults / generated
values optional. `InferUpdateModel` is the partial form for `.set(...)`.

### Relational query API (drizzle's `db.query.users.findMany`)

No relational layer in sumak — this is intentional (see
`docs/competitor-notes.md`). Write the join you want:

```ts
// drizzle
const usersWithPosts = await db.query.users.findMany({ with: { posts: true } })
```

```ts
// sumak
const usersWithPosts = await db
  .selectFrom("users")
  .leftJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))
  .select("users.id", "users.name", "posts.id", "posts.title")
  .many()
```

For "one row per parent with an array of children" on PostgreSQL: use
`jsonAgg(...)` + correlated subquery, or `jsonBuildObject(...)` in a
`LEFT JOIN LATERAL`. No relations file needed.

---

## 4. Things sumak has that the other two don't

Short, non-exhaustive list of features that are sumak-specific:

- **AST normalization / optimization pipeline.** Predicate simplification
  (`x AND true` → `x`, `1 + 2` → `3`), AND/OR flattening, dedup,
  predicate pushdown into joins, subquery flattening. Off-switch via
  `sumak({ normalize: false, optimizeQueries: false })`. Custom rules
  via `createRule({ name, match, apply })`.
- **Per-dialect feature matrix with explicit errors.** Each feature
  carries a list of supporting dialects; non-supporting printers throw
  `UnsupportedDialectFeatureError` at compile time. No silent fallback.
- **First-class DDL surface.** CREATE / DROP / ALTER for TABLE, INDEX,
  VIEW (`materialized()` / `orReplace()`), SEQUENCE, TYPE
  (`createTypeEnum`, `alterTypeAddValue`, `alterTypeRename`,
  `alterTypeRenameValue`), DOMAIN, EXTENSION, POLICY (RLS), COPY
  (`copyFrom` / `copyTo`), TRUNCATE, VACUUM / ANALYZE / REINDEX, LOCK
  TABLE, LISTEN / NOTIFY / UNLISTEN. Same call shape as the DML builders.
- **Schema-diff migrations.** `diffSchemas(before, after)` returns a
  topologically-sorted DDL plan; `applyMigration(db, before, after)`
  executes in a single transaction with a destructive-change guard.
- **Plugin ecosystem.** Factory-function plugins for `softDelete`
  (with explicit `db.softDelete(table)` / `db.restore(table)`
  builders), `audit`, `multiTenant`, `optimisticLock`, `withSchema`,
  `queryLimit`, `caslAuthz`, `subjectType`, `camelCase`, `dataMasking`,
  `defaults`, `normalizeStrings`, `validators`, `debugLogger`. No
  `new`, no class imports.
- **Compiled queries.** `.toCompiled<P>()` pre-bakes SQL at setup time
  so the runtime hot path is `params.fill()` instead of an AST walk.
- **Property-based fuzz tests on the compiler.** The optimizer and
  printer run under fast-check generators; the round-trip invariant
  is checked over hundreds of random ASTs per run.
- **Modern SQL surface in the typed layer.** `anyValue`,
  `percentileCont` / `percentileDisc` + `withinGroup`, `isJson`, frame
  `EXCLUDE` clauses, regex helpers (`regexpLike` / `regexpReplace` /
  `regexpMatches` / `regexpSubstr`), sequence access (`nextval` /
  `currval` / `setval`), named `WINDOW` clauses with inheritance,
  `LATERAL` joins, `FOR UPDATE` with `SKIP LOCKED` / `NOWAIT` /
  `OF [...]`, MERGE (SQL:2003), temporal `FOR SYSTEM_TIME` (SQL:2011),
  property graphs (SQL/PGQ, experimental).

---

## 5. Migration mechanics — running sumak alongside the old library

The most painless migration is to leave the old library in place and
port endpoint by endpoint. Both kysely and drizzle compose at the pool
level — they take a `pg.Pool` (or equivalent) and own nothing above it.
sumak does the same. Share the pool, run the two builders side by side:

```ts
import { Pool } from "pg"
import { Kysely, PostgresDialect } from "kysely"
import { sumak, pgDialect, type Driver } from "sumak"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// kysely — existing
export const kdb = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
})

// sumak — new endpoints use this
const driver: Driver = {
  async query(sql, params) {
    const r = await pool.query(sql, [...params])
    return r.rows
  },
  async execute(sql, params) {
    const r = await pool.query(sql, [...params])
    return { affected: r.rowCount ?? 0 }
  },
}

export const sdb = sumak({
  dialect: pgDialect(),
  driver,
  tables: {
    /* ... */
  },
})
```

The two instances share the pool, but transactions started in one
library are not visible in the other — keep each transaction inside a
single library. If you need one transaction across both, drop to
`pool.connect()` and pass the resulting `Client` to both via the same
adapter pattern.

For drizzle: same picture — `const ddb = drizzle(pool, { schema })`
existing, `const sdb = sumak({ /* ... */ })` new.

### Suggested ordering

1. **Schema first.** Either hand-write the sumak `tables` map from
   existing migrations, or run `sumak introspect` against a dev DB.
2. **Read-only endpoints next.** SELECTs are pure functions of their
   parameters and easy to A/B against the existing library.
3. **Writes after reads settle.** The plugin layer pays off here —
   `softDelete`, `audit`, `multiTenant`, `optimisticLock` collapse a
   lot of hand-rolled write-path boilerplate.
4. **Authz once a few tables are on sumak.** `caslAuthz` rewrites
   every `SELECT` / `UPDATE` / `DELETE` to AND in the authz predicate
   — one line of config replaces a layer of repetitive `.where(...)`.
5. **CTEs, window functions, MERGE last** — these surfaces differ
   most, port them when the call sites are otherwise stable.

### When to keep the old library

Two cases where staying makes sense: (1) drizzle's relational API
(`db.query.users.findMany({ with: { posts: true } })`) is load-bearing
for your codebase — sumak doesn't ship one (see §3); (2) you're on a
runtime sumak doesn't claim to support — examples target Node 24+, the
rest is best-effort.

For everything else — typed builders, plugins, multi-dialect printers,
schema-diff migrations — the port is mostly a find-and-replace on the
call sites plus a one-time conversion of the schema file.
