# Recipes

Practical patterns for common queries. Each example shows the sumak builder call, the emitted SQL (PG dialect), and notes on what makes the pattern non-obvious or dialect-specific.

The examples assume a schema like:

```ts
import { sumak, pgDialect, serial, text, integer, timestamp, boolean } from "sumak"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull().unique(),
      active: boolean().defaultTo(true),
      tenantId: integer().notNull(),
      deletedAt: timestamp().nullable(),
      createdAt: timestamp().notNull(),
    },
    posts: {
      id: serial().primaryKey(),
      authorId: integer().notNull(),
      title: text().notNull(),
      body: text().notNull(),
      published: integer().notNull(),
    },
  },
})
```

---

## Filter by ID list

Both the typed `.in()` callback and the kysely-style three-arg form
emit identical SQL:

```ts
// Callback
db.selectFrom("users")
  .where(({ id }) => id.in([1, 2, 3]))
  .toSQL()
// Three-arg
db.selectFrom("users").where("id", "in", [1, 2, 3]).toSQL()

// SELECT * FROM "users" WHERE ("id" IN ($1, $2, $3))
// params: [1, 2, 3]
```

For dynamic ID arrays, guard the empty case so you don't get `IN ()` (a parse error in every dialect). sumak's printer constant-folds the empty `IN` to `FALSE` (or `(1=0)` on MSSQL), but it's still good practice to short-circuit at the application layer.

---

## Pagination with stable ordering

```ts
db.selectFrom("posts")
  .selectAll()
  .where(({ published }) => published.gt(0))
  .orderBy("createdAt", "DESC")
  .orderBy("id", "ASC") // tie-breaker — never paginate on a non-unique column alone
  .limit(20)
  .offset(40)
```

`createdAt` alone isn't stable for pagination because two rows can share the same timestamp; if the second order key is a unique column (here `id`) the pagination is deterministic. Without the tie-breaker, the same row can appear on two pages.

---

## Keyset pagination (cursor-based)

`OFFSET N` gets expensive past page ~50 because the database has to scan and discard. Keyset is O(1) regardless of page depth:

```ts
function pageAfter(lastSeenId: number | null) {
  const q = db.selectFrom("posts").selectAll().orderBy("id", "ASC").limit(20)
  return lastSeenId === null ? q : q.where(({ id }) => id.gt(lastSeenId))
}
```

The first page passes `null`; every subsequent page passes the `id` of the last row from the previous page. Works for any monotonically-increasing ordering column (timestamps, sequences, ULIDs).

---

## Upsert pattern (INSERT … ON CONFLICT DO UPDATE)

```ts
db.insertInto("users")
  .values({ name: "Ada", email: "ada@x.io", tenantId: 1, createdAt: new Date() })
  .onConflict({ columns: ["email"], do: { update: { name: "Ada" } } })
  .returning("id")
  .toSQL()

// INSERT INTO "users" (...) VALUES (...)
//   ON CONFLICT ("email") DO UPDATE SET "name" = $N
//   RETURNING "id"
```

`onConflict` accepts either a column list (`{ columns: [...] }`) or a named unique constraint (`{ constraint: "users_email_key" }`). The latter is more robust against schema changes that drop or rename the unique index.

---

## Aggregate with FILTER (PostgreSQL)

```ts
import { count, filter, typedCol, typedGt } from "sumak"

db.selectFrom("posts")
  .select({
    total: count(),
    published: filter(count(), typedGt(typedCol<number>("published"), typedLit(0))),
  })
  .toSQL()

// SELECT
//   COUNT(*) AS "total",
//   COUNT(*) FILTER (WHERE "published" > $1) AS "published"
// FROM "posts"
```

`FILTER (WHERE …)` is the cleanest way to count or sum a subset without `CASE WHEN` inside the aggregate. PG and SQLite 3.30+ support it; MySQL needs `COUNT(CASE WHEN cond THEN 1 END)`.

---

## Soft delete on the read path

Register the `softDelete` plugin once:

```ts
const db = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [softDelete({ tables: ["users"] })],
})
```

Every `SELECT` from a registered table now auto-injects `WHERE "deletedAt" IS NULL`. Bypass for a specific query with `.includeDeleted()` or `.onlyDeleted()`:

```ts
db.selectFrom("users").includeDeleted().selectAll().toSQL()
// SELECT * FROM "users"
//   (the WHERE deleted_at IS NULL is omitted)
```

DELETE statements get rewritten to UPDATE: `delete-where → UPDATE ... SET deleted_at = CURRENT_TIMESTAMP`. Tested in the integration suite against a real PG.

---

## Partial indexes (PostgreSQL / SQLite)

A partial index is `CREATE INDEX ... WHERE <predicate>` — only rows matching the predicate are stored in the index, so the index is smaller and queries that include the same predicate land on a hot, narrow B-tree. The classic case is soft-deleted rows: 99% of reads ignore them, so there's no reason to keep them in the read path's main indexes.

Declare on the table:

```ts
const users = defineTable(
  "users",
  {
    id: serial().primaryKey(),
    email: text().notNull(),
    deletedAt: timestamp().nullable(),
  },
  {
    indexes: [
      // Unique on email — but only for live rows. A soft-deleted user
      // can re-use their email, and a live user can re-create with the
      // same address only after the old row is hard-deleted.
      {
        name: "uq_users_email_active",
        columns: ["email"],
        unique: true,
        where: '"deletedAt" IS NULL',
      },
    ],
  },
)
```

Emitted SQL (PG / SQLite):

```sql
CREATE UNIQUE INDEX "uq_users_email_active"
  ON "users" ("email")
  WHERE "deletedAt" IS NULL
```

For status-driven workloads, gate the index on the hot enum value so cold rows aren't paid for on every write:

```ts
{
  name: "idx_orders_pending",
  columns: ["createdAt"],
  where: "status = 'pending'",
}
```

The predicate is part of the index's identity: change the `where` clause and the migration diff drops + recreates the index in one step. The expression accepts raw SQL (schema-author controlled — never user input) or any `Expression<boolean>`. When you reference camelCase columns by raw SQL, quote them yourself (`"deletedAt"` on PG, `` `deletedAt` `` on SQLite) — sumak's automatic identifier quoting only applies to identifiers it owns at print time, not strings inside raw SQL.

**Dialect support.** PG and SQLite (≥ 3.8) accept the standard form. MySQL has no partial-index grammar at all; MSSQL's "filtered indexes" use a similar `WHERE` clause but with a stricter subset of allowed predicates (no UDFs, no subqueries, restrictions on BIT columns). sumak refuses to emit on MySQL and MSSQL — `compileDDL` throws `UnsupportedDialectFeatureError` — rather than ship SQL the engine will reject at runtime.

---

## Multi-tenant scoping

```ts
const db = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [
    multiTenant({
      tables: ["users", "posts"],
      tenantId: () => requestContext.tenantId,
    }),
  ],
})
```

Every SELECT / UPDATE / DELETE on a mapped table auto-injects `WHERE "tenantId" = $N`. The `tenantId` callback fires per compile, so you can wire it to `AsyncLocalStorage` for per-request tenant scoping (similar to the `caslAuthz` ability-factory pattern in #97).

For cross-tenant queries (admin reports, etc.), `.crossTenant({ reason: "..." })` is the explicit escape hatch:

```ts
db.selectFrom("users")
  .crossTenant({ reason: "admin dashboard — aggregates across all tenants" })
  .selectAll()
  .many()
```

---

## CASL row-level authorization

Define abilities, register the plugin, query as usual:

```ts
import { AbilityBuilder, createMongoAbility } from "@casl/ability"

const { can, build } = new AbilityBuilder(createMongoAbility)
can("read", "Post", { authorId: currentUserId })
can("read", "Post", { published: true })
const ability = build()

const db = sumak({
  dialect: pgDialect(),
  tables,
  plugins: [
    caslAuthz({
      ability,
      subjects: { posts: "Post" },
    }),
  ],
})

// Now every SELECT on "posts" auto-injects the CASL WHERE.
db.selectFrom("posts").selectAll().many()
// SELECT * FROM "posts" WHERE ("authorId" = $1 OR "published" = $2)
```

For per-request abilities (the common case in a pooled-connection app), pass a factory function:

```ts
caslAuthz({
  ability: () => abilityCtx.getStore() ?? throwNoAbility(),
  subjects: { posts: "Post" },
})
```

The factory fires per compile so the same `sumak()` instance serves multiple concurrent requests. See `caslAuthz`'s JSDoc for the full pattern.

---

## Window function: running total

```ts
import { over, sum, typedCol } from "sumak"

db.selectFrom("orders")
  .select("id", "createdAt", "amount", {
    runningTotal: over(sum(typedCol<number>("amount")), (w) =>
      w.orderBy("createdAt").rows({ type: "unbounded_preceding" }, { type: "current_row" }),
    ),
  })
  .toSQL()

// SELECT id, "createdAt", "amount",
//        SUM("amount") OVER (ORDER BY "createdAt" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "runningTotal"
// FROM "orders"
```

Window frames default to `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, which is "all rows up to and including ties on the ORDER BY column". `.rows(...)` is the row-count-anchored version — usually what you want for a running total. The difference matters when the ORDER BY column has ties.

---

## Date / time component extraction and truncation

```ts
import { age, count, dateTrunc, extract, typedCol } from "sumak"

// EXTRACT(field FROM expr) — SQL standard, works on all four dialects
// (the recognised field set varies: YEAR/MONTH/DAY/HOUR/MINUTE/SECOND
// are portable; PG adds EPOCH, DOW, DOY, ISOYEAR, ISODOW, ...).
db.selectFrom("events")
  .select({
    yr: extract("year", typedCol<Date>("created_at")),
    mo: extract("month", typedCol<Date>("created_at")),
    dow: extract("dow", typedCol<Date>("created_at")), // PG-only
  })
  .toSQL()
// SELECT EXTRACT(YEAR FROM "created_at") AS "yr",
//        EXTRACT(MONTH FROM "created_at") AS "mo",
//        EXTRACT(DOW FROM "created_at") AS "dow"
// FROM "events"

// DATE_TRUNC('unit', expr) — PG only. The classic per-bucket aggregate
// pattern: group rows by truncated month / day / hour.
const bucket = dateTrunc("month", typedCol<Date>("created_at"))
db.selectFrom("events")
  .select({ month: bucket, n: count() })
  .groupBy(bucket)
  .orderBy(bucket)
  .toSQL()
// SELECT DATE_TRUNC('month', "created_at") AS "month", COUNT(*) AS "n"
// FROM "events"
// GROUP BY DATE_TRUNC('month', "created_at")
// ORDER BY DATE_TRUNC('month', "created_at") ASC

// AGE(end, start) / AGE(start) — PG only. Returns an interval, not a
// numeric. Wrap with `EXTRACT(EPOCH FROM AGE(...))` to get seconds.
db.selectFrom("users")
  .select({ tenure: age(typedCol<Date>("hired_at")) })
  .toSQL()
// SELECT AGE("hired_at") AS "tenure" FROM "users"
```

`dateTrunc` and `age` are PG-only — the printer throws `UnsupportedDialectFeatureError` on MySQL / SQLite / MSSQL. `extract` works on all four dialects for the SQL standard field names; dialect-specific extras (PG's `EPOCH`, `DOW`, `ISOYEAR`) parse on PG and fail at execution time on the others. Reach for `unsafeRawExpr` if you need a portable equivalent (MySQL: `DATE_FORMAT(ts, '%Y-%m-01')`; MSSQL pre-2022: `DATEADD(month, DATEDIFF(month, 0, ts), 0)`; SQLite: `strftime('%Y-%m-01', ts)`).

---

## EXISTS / NOT EXISTS (correlated subquery)

```ts
import { exists } from "sumak"

const hasPublishedPosts = db
  .selectFrom("posts")
  .selectAll()
  .where(({ authorId }) => authorId.gt(0))
  .build()

db.selectFrom("users")
  .selectAll()
  .where(() => exists(hasPublishedPosts))
  .toSQL()
```

The inner query references the outer's `users.id`; that's what makes it correlated. `.build()` returns the raw `SelectNode` that `exists()` accepts.

For uncorrelated `WHERE x IN (subquery)`, use `id.in(subquery)` — also accepts a built `SelectNode`.

---

## Bulk insert with RETURNING

```ts
const inserted = await db
  .insertInto("users")
  .valuesMany([
    { name: "Ada", email: "ada@x.io", tenantId: 1, createdAt: new Date() },
    { name: "Bob", email: "bob@x.io", tenantId: 1, createdAt: new Date() },
  ])
  .returning("id", "email")
  .many()

// inserted is now Array<{ id: number; email: string }>
```

PG and SQLite ≥ 3.35 return one row per inserted row; MySQL has `LAST_INSERT_ID()` instead and sumak's MySQL printer surfaces an error if you call `.returning()` against it. MariaDB has the standard form and works.

---

## Type-safe row inference

Three drizzle-compatible helpers infer row shapes from the column map:

```ts
import { InferSelectModel, InferInsertModel, InferUpdateModel } from "sumak"

type User = InferSelectModel<typeof tables.users>
// { id: number; name: string; email: string; active: boolean; tenantId: number; deletedAt: Date | null; createdAt: Date }

type NewUser = InferInsertModel<typeof tables.users>
// { name: string; email: string; tenantId: number; createdAt: Date; id?: number; active?: boolean; deletedAt?: Date | null }

type UserUpdate = InferUpdateModel<typeof tables.users>
// All keys optional.
```

Use these for typing function arguments, REST handler request bodies, form payloads — anywhere you want the row shape without re-declaring it.

---

## Common pitfalls

### `.where("col")` (one arg) throws

The runtime guard from PR #95 catches the silent-no-op bug where a typo'd `.where("col", "=", val)` was dropping the operator and value. Single-arg or two-arg string calls now throw with a hint:

```
.where() expected an Expression<boolean> or a callback returning one.
Got string "id". Use the callback form: .where(({ col }) => col.eq(value))
```

The valid shapes: `.where(callback)`, `.where("col", "op", val)`, `.where(expression)`.

### Callback body without `return`

```ts
db.selectFrom("users").where((c) => {
  c.id.eq(1) // ← effect-only; the callback returns undefined
})
```

This throws:

```
.where(callback) — your callback returned undefined. Most likely either
(a) the arrow body is missing a `return` (e.g. `(c) => { c.id.eq(1) }`
instead of `(c) => c.id.eq(1)`)…
```

Drop the braces or add `return`.

### Empty `IN (...)`

```ts
.where(({ id }) => id.in([]))
```

Per SQL spec, `col IN ()` is a parse error. sumak's printer folds this to `FALSE` (or `(1=0)` on MSSQL) so the query stays valid. The expected behavior — "match nothing" — is preserved; the gotcha is that the optimizer can't push that constant through every plan, so applications with a meaningful "no IDs" branch should short-circuit at the JS layer instead.

### `bigint` parameters

PG and MySQL accept `bigint` directly via the driver. SQLite's `better-sqlite3` returns them as `BigInt` if you opt in. sumak coerces `bigint` to `string` in the param array because `node-postgres` and `mysql2` both stringify silently and SQLite has its own handling. If you need precision-preserving roundtrips, use the driver's BigInt mode and explicitly cast at the application layer.
