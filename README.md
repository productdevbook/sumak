<p align="center">
  <br>
  <img src=".github/assets/cover.jpg" alt="sumak — Type-safe SQL query builder" width="100%">
  <br><br>
  <b style="font-size: 2em;">sumak</b>
  <br><br>
  Type-safe SQL query builder with powerful SQL printers.
  <br>
  Zero dependencies, AST-first, hookable, tree-shakeable. Pure TypeScript, works everywhere.
  <br><br>
  <a href="https://npmjs.com/package/sumak"><img src="https://img.shields.io/npm/v/sumak?style=flat&colorA=18181B&colorB=e11d48" alt="npm version"></a>
  <a href="https://npmjs.com/package/sumak"><img src="https://img.shields.io/npm/dm/sumak?style=flat&colorA=18181B&colorB=e11d48" alt="npm downloads"></a>
  <a href="https://bundlephobia.com/result?p=sumak"><img src="https://img.shields.io/bundlephobia/minzip/sumak?style=flat&colorA=18181B&colorB=e11d48" alt="bundle size"></a>
  <a href="https://github.com/productdevbook/sumak/blob/main/LICENSE"><img src="https://img.shields.io/github/license/productdevbook/sumak?style=flat&colorA=18181B&colorB=e11d48" alt="license"></a>
</p>

## Quick Start

```sh
npm install sumak
```

```ts
import { sumak, pgDialect, serial, text, boolean, integer, jsonb } from "sumak"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer(),
      active: boolean().defaultTo(true),
      meta: jsonb(),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      userId: integer().references("users", "id"),
    },
  },
})
```

## Query Building

### SELECT

```ts
db.selectFrom("users")
  .select("id", "name")
  .where(({ age, active }) => and(age.gte(18), active.eq(true)))
  .orderBy("name")
  .limit(10)
  .compile(db.printer())
```

### INSERT

```ts
db.insertInto("users")
  .values({
    name: "Alice",
    email: "alice@example.com",
  })
  .returningAll()
  .compile(db.printer())
```

### UPDATE

```ts
db.update("users")
  .set({ active: false })
  .where(({ id }) => id.eq(1))
  .compile(db.printer())
```

### DELETE

```ts
db.deleteFrom("users")
  .where(({ id }) => id.eq(1))
  .returning("id")
  .compile(db.printer())
```

## Joins

```ts
// INNER JOIN
db.selectFrom("users")
  .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .select("id", "title")
  .compile(db.printer())

// LEFT JOIN — joined columns become nullable
db.selectFrom("users")
  .leftJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .compile(db.printer())

// RIGHT JOIN
db.selectFrom("users")
  .rightJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .compile(db.printer())

// FULL JOIN — both sides become nullable
db.selectFrom("users")
  .fullJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .compile(db.printer())

// CROSS JOIN — cartesian product
db.selectFrom("users").crossJoin("posts").compile(db.printer())
```

## Expression API

### Comparisons

```ts
.where(({ id }) =>
  id.eq(42),
)

.where(({ age }) =>
  age.gt(18),
)

.where(({ age }) =>
  age.gte(18),
)

.where(({ age }) =>
  age.lt(65),
)

.where(({ age }) =>
  age.lte(65),
)

.where(({ active }) =>
  active.neq(false),
)
```

### String Matching

```ts
.where(({ name }) =>
  name.like("%ali%"),
)

.where(({ name }) =>
  name.notLike("%bob%"),
)

// Case-insensitive (PG)
.where(({ name }) =>
  name.ilike("%alice%"),
)

.where(({ email }) =>
  email.notIlike("%spam%"),
)
```

### Range & List

```ts
.where(({ age }) =>
  age.between(18, 65),
)

.where(({ age }) =>
  age.notBetween(18, 65),
)

// Order-independent (PG)
.where(({ age }) =>
  age.betweenSymmetric(65, 18),
)

.where(({ id }) =>
  id.in([1, 2, 3]),
)

.where(({ id }) =>
  id.notIn([99, 100]),
)
```

### Null Checks

```ts
.where(({ bio }) =>
  bio.isNull(),
)

.where(({ email }) =>
  email.isNotNull(),
)
```

### Logical Combinators

```ts
// AND
.where(({ age, active }) =>
  and(
    age.gt(0),
    active.eq(true),
  ),
)

// OR
.where(({ name, email }) =>
  or(
    name.like("%alice%"),
    email.like("%alice%"),
  ),
)

// NOT
.where(({ active }) =>
  not(active.eq(true)),
)
```

### Aggregates

```ts
import { count, countDistinct, sum, avg, min, max, coalesce } from "sumak"

db.selectFrom("users").selectExpr(count(), "total").compile(db.printer())

db.selectFrom("users").selectExpr(countDistinct(col.dept), "uniqueDepts").compile(db.printer())
// SELECT COUNT(DISTINCT "dept") AS "uniqueDepts" FROM "users"

db.selectFrom("orders").selectExpr(sum(col.amount), "totalAmount").compile(db.printer())

db.selectFrom("orders").selectExpr(avg(col.amount), "avgAmount").compile(db.printer())

db.selectFrom("orders")
  .selectExpr(coalesce(col.discount, val(0)), "safeDiscount")
  .compile(db.printer())
```

### EXISTS / NOT EXISTS

```ts
import { exists, notExists } from "sumak"

db.selectFrom("users")
  .where(() =>
    exists(
      db
        .selectFrom("posts")
        .where(({ userId }) => userId.eq(1))
        .build(),
    ),
  )
  .compile(db.printer())

db.selectFrom("users")
  .where(() =>
    notExists(
      db
        .selectFrom("posts")
        .where(({ userId }) => userId.eq(1))
        .build(),
    ),
  )
  .compile(db.printer())
```

### CASE Expression

```ts
import { case_, val } from "sumak"

db.selectFrom("users")
  .selectExpr(
    case_()
      .when(col.active.eq(true), val("active"))
      .when(col.active.eq(false), val("inactive"))
      .else_(val("unknown"))
      .end(),
    "status",
  )
  .compile(db.printer())
```

### CAST

```ts
import { cast, val } from "sumak"

db.selectFrom("users")
  .selectExpr(cast(val(42), "text"), "idAsText")
  .compile(db.printer())
```

### JSON Operations

```ts
import { jsonRef } from "sumak"

// ->  (JSON object)
db.selectFrom("users")
  .selectExpr(jsonRef(col.meta, "address", "->"), "address")
  .compile(db.printer())

// ->> (text value)
db.selectFrom("users")
  .selectExpr(jsonRef(col.meta, "name", "->>"), "metaName")
  .compile(db.printer())
```

## Window Functions

```ts
import { over, rowNumber, rank, denseRank, lag, lead, ntile, count, sum } from "sumak"

// ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC)
db.selectFrom("employees")
  .selectExpr(
    over(rowNumber(), (w) => w.partitionBy("dept").orderBy("salary", "DESC")),
    "rn",
  )
  .compile(db.printer())

// RANK() OVER (ORDER BY score DESC)
db.selectFrom("students")
  .selectExpr(
    over(rank(), (w) => w.orderBy("score", "DESC")),
    "rnk",
  )
  .compile(db.printer())

// Running total with frame
db.selectFrom("orders")
  .selectExpr(
    over(sum(col.amount), (w) =>
      w
        .partitionBy("userId")
        .orderBy("createdAt")
        .rows({ type: "unbounded_preceding" }, { type: "current_row" }),
    ),
    "runningTotal",
  )
  .compile(db.printer())

// LAG / LEAD
db.selectFrom("prices")
  .selectExpr(
    over(lag(col.price, 1), (w) => w.orderBy("date")),
    "prevPrice",
  )
  .compile(db.printer())

// NTILE(4)
db.selectFrom("employees")
  .selectExpr(
    over(ntile(4), (w) => w.orderBy("salary", "DESC")),
    "quartile",
  )
  .compile(db.printer())
```

## SQL Functions

### String Functions

```ts
import { upper, lower, concat, substring, trim, length } from "sumak"

db.selectFrom("users").selectExpr(upper(col.name), "upperName").compile(db.printer())
// SELECT UPPER("name") AS "upperName" FROM "users"

db.selectFrom("users").selectExpr(lower(col.email), "lowerEmail").compile(db.printer())

db.selectFrom("users")
  .selectExpr(concat(col.firstName, val(" "), col.lastName), "fullName")
  .compile(db.printer())

db.selectFrom("users")
  .selectExpr(substring(col.name, 1, 3), "prefix")
  .compile(db.printer())

db.selectFrom("users").selectExpr(trim(col.name), "trimmed").compile(db.printer())

db.selectFrom("users").selectExpr(length(col.name), "nameLen").compile(db.printer())
```

### Numeric Functions

```ts
import { abs, round, ceil, floor } from "sumak"

db.selectFrom("orders").selectExpr(abs(col.balance), "absBalance").compile(db.printer())

db.selectFrom("orders").selectExpr(round(col.price, 2), "rounded").compile(db.printer())

db.selectFrom("orders").selectExpr(ceil(col.amount), "ceiling").compile(db.printer())

db.selectFrom("orders").selectExpr(floor(col.amount), "floored").compile(db.printer())
```

### Conditional Functions

```ts
import { nullif, greatest, least } from "sumak"

db.selectFrom("users")
  .selectExpr(nullif(col.age, val(0)), "ageOrNull")
  .compile(db.printer())

db.selectFrom("products")
  .selectExpr(greatest(col.price, col.minPrice), "effectivePrice")
  .compile(db.printer())

db.selectFrom("products")
  .selectExpr(least(col.price, col.maxPrice), "cappedPrice")
  .compile(db.printer())
```

### Date/Time Functions

```ts
import { now, currentTimestamp } from "sumak"

db.selectFrom("users").selectExpr(now(), "currentTime").compile(db.printer())
```

## Set Operations

```ts
const active = db
  .selectFrom("users")
  .select("id")
  .where(({ active }) => active.eq(true))

const premium = db
  .selectFrom("users")
  .select("id")
  .where(({ active }) => active.eq(true))

// UNION
active.union(premium).compile(db.printer())

// UNION ALL
active.unionAll(premium).compile(db.printer())

// INTERSECT / INTERSECT ALL
active.intersect(premium).compile(db.printer())
active.intersectAll(premium).compile(db.printer())

// EXCEPT / EXCEPT ALL
active.except(premium).compile(db.printer())
active.exceptAll(premium).compile(db.printer())
```

## CTEs (WITH)

```ts
// SELECT with CTE
db.selectFrom("users")
  .with(
    "active_users",
    db
      .selectFrom("users")
      .where(({ active }) => active.eq(true))
      .build(),
  )
  .compile(db.printer())

// INSERT with CTE
db.insertInto("users")
  .with("source", sourceCte)
  .values({ name: "Alice", email: "a@b.com" })
  .compile(db.printer())

// UPDATE with CTE
db.update("users").with("target", targetCte).set({ active: false }).compile(db.printer())

// DELETE with CTE
db.deleteFrom("users")
  .with("to_delete", deleteCte)
  .where(({ id }) => id.eq(1))
  .compile(db.printer())

// Recursive CTE
db.selectFrom("users").with("tree", recursiveQuery, true).compile(db.printer())
```

## UPDATE FROM

```ts
db.update("users")
  .set({ name: "Bob" })
  .from("posts")
  .where(({ id }) => id.eq(1))
  .compile(db.printer())
// UPDATE "users" SET "name" = $1 FROM "posts" WHERE ("id" = $2)
```

## Conditional Query Building

```ts
const withFilter = true
const withOrder = false

db.selectFrom("users")
  .select("id", "name")
  .$if(withFilter, (qb) => qb.where(({ age }) => age.gt(18)))
  .$if(withOrder, (qb) => qb.orderBy("name"))
  .compile(db.printer())
// WHERE applied, ORDER BY skipped

// Multiple .where() calls are AND'd together
db.selectFrom("users")
  .select("id")
  .where(({ age }) => age.gt(18))
  .where(({ active }) => active.eq(true))
  .compile(db.printer())
// WHERE ("age" > $1) AND ("active" = $2)
```

## INSERT Advanced

```ts
// INSERT ... SELECT
const selectQuery = db.selectFrom("users").select("name", "age").build()
db.insertInto("archive").fromSelect(selectQuery).compile(db.printer())

// INSERT ... DEFAULT VALUES
db.insertInto("users").defaultValues().compile(db.printer())

// SQLite: INSERT OR IGNORE / INSERT OR REPLACE
db.insertInto("users").values({ name: "Alice" }).orIgnore().compile(db.printer())
// INSERT OR IGNORE INTO "users" ...

db.insertInto("users").values({ name: "Alice" }).orReplace().compile(db.printer())
// INSERT OR REPLACE INTO "users" ...
```

## ON CONFLICT

```ts
// DO NOTHING (by columns)
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictDoNothing("email")
  .compile(db.printer())

// DO UPDATE (by columns)
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictDoUpdate(["email"], [{ column: "name", value: val("Alice") }])
  .compile(db.printer())

// DO NOTHING (by constraint name)
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictConstraintDoNothing("users_email_key")
  .compile(db.printer())
// ON CONFLICT ON CONSTRAINT "users_email_key" DO NOTHING

// MySQL: ON DUPLICATE KEY UPDATE
db.insertInto("users")
  .values({ name: "Alice" })
  .onDuplicateKeyUpdate([{ column: "name", value: val("Alice") }])
  .compile(db.printer())
```

## MERGE (SQL:2003)

```ts
db.mergeInto("users", "staging", "s", ({ target, source }) => target.id.eqCol(source.id))
  .whenMatchedThenUpdate({ name: "updated" })
  .whenNotMatchedThenInsert({
    name: "Alice",
    email: "alice@example.com",
  })
  .compile(db.printer())

// MERGE with conditional delete
db.mergeInto("users", "staging", "s", ({ target, source }) => target.id.eqCol(source.id))
  .whenMatchedThenDelete()
  .compile(db.printer())
```

## Row Locking

```ts
// FOR UPDATE
db.selectFrom("users").select("id").forUpdate().compile(db.printer())

// FOR SHARE
db.selectFrom("users").select("id").forShare().compile(db.printer())

// FOR NO KEY UPDATE / FOR KEY SHARE (PG)
db.selectFrom("users").select("id").forNoKeyUpdate().compile(db.printer())
db.selectFrom("users").select("id").forKeyShare().compile(db.printer())

// SKIP LOCKED / NOWAIT
db.selectFrom("users").select("id").forUpdate().skipLocked().compile(db.printer())
db.selectFrom("users").select("id").forUpdate().noWait().compile(db.printer())
```

## DISTINCT ON (PG)

```ts
db.selectFrom("users")
  .selectAll()
  .distinctOn("dept")
  .orderBy("dept")
  .orderBy("salary", "DESC")
  .compile(db.printer())
// SELECT DISTINCT ON ("dept") * FROM "users" ORDER BY "dept" ASC, "salary" DESC
```

## DELETE USING / JOIN in UPDATE & DELETE

```ts
// PG: DELETE ... USING
db.deleteFrom("orders")
  .using("users")
  .where(eq(col("orders.user_id"), col("users.id")))
  .compile(db.printer())

// MySQL: DELETE with JOIN
db.deleteFrom("orders")
  .innerJoin("users", eq(col("user_id", "orders"), col("id", "users")))
  .where(eq(col("name", "users"), lit("Alice")))
  .compile(db.printer())

// MySQL: UPDATE with JOIN
db.update("orders")
  .set({ total: 0 })
  .innerJoin("users", eq(col("user_id", "orders"), col("id", "users")))
  .compile(db.printer())
```

## Lateral JOIN

```ts
// INNER JOIN LATERAL — correlated subquery join
const recentPosts = db
  .selectFrom("posts")
  .select("id", "title")
  .where(({ userId }) => userId.eq(1))
  .limit(3)

db.selectFrom("users").innerJoinLateral(recentPosts, "rp", onExpr).compile(db.printer())
// SELECT * FROM "users" INNER JOIN LATERAL (SELECT ...) AS "rp" ON ...

// LEFT JOIN LATERAL
db.selectFrom("users").leftJoinLateral(recentPosts, "rp", onExpr).compile(db.printer())
```

## Tuple Comparisons

```ts
import { tuple, val } from "sumak"

// Row-value comparison: (id, age) = (1, 25)
db.selectFrom("users")
  .selectExpr(tuple(val(1), val(2), val(3)), "triple")
  .compile(db.printer())
// (1, 2, 3)
```

## SQL Template Literal

```ts
import { sql, val } from "sumak"

// Tagged template with auto-parameterization
sql`SELECT * FROM users WHERE name = ${"Alice"}`
// params: ["Alice"]

// Inline Expression values
sql`SELECT * FROM users WHERE active = ${val(true)}`
// → SELECT * FROM users WHERE active = TRUE

// Helpers
sql`SELECT ${sql.ref("id")} FROM ${sql.table("users", "public")}`
// → SELECT "id" FROM "public"."users"

// Use in selectExpr
db.selectFrom("users")
  .selectExpr(sql`CURRENT_DATE`, "today")
  .compile(db.printer())
```

## Aggregate FILTER (WHERE)

```ts
import { filter, count, sum } from "sumak"

// COUNT(*) FILTER (WHERE active = true)
db.selectFrom("users").selectExpr(filter(count(), activeExpr), "activeCount").compile(db.printer())
```

## EXPLAIN

```ts
// EXPLAIN
db.selectFrom("users").select("id").explain().compile(db.printer())
// EXPLAIN SELECT "id" FROM "users"

// EXPLAIN ANALYZE
db.selectFrom("users").select("id").explain({ analyze: true }).compile(db.printer())

// EXPLAIN with format
db.selectFrom("users").select("id").explain({ format: "JSON" }).compile(db.printer())
// EXPLAIN (FORMAT JSON) SELECT "id" FROM "users"
```

## Full-Text Search

Dialect-aware FTS — same API, different SQL per dialect:

```ts
import { textSearch } from "sumak"

// PostgreSQL: to_tsvector("name") @@ to_tsquery('alice')
db.selectFrom("users")
  .where(({ name }) => textSearch([name.toExpr()], val("alice")))
  .compile(db.printer())

// With language config
db.selectFrom("users")
  .where(({ name }) => textSearch([name.toExpr()], val("alice"), { language: "english" }))
  .compile(db.printer())

// MySQL: MATCH(`name`) AGAINST(? IN BOOLEAN MODE)
// SQLite: ("name" MATCH ?)
// MSSQL: CONTAINS(([name]), @p0)
```

## Temporal Tables (SQL:2011)

Query historical data with `FOR SYSTEM_TIME`:

```ts
// AS OF — point-in-time query
db.selectFrom("users")
  .forSystemTime({
    kind: "as_of",
    timestamp: lit("2024-01-01"),
  })
  .compile(db.printer())

// BETWEEN — time range
db.selectFrom("users")
  .forSystemTime({
    kind: "between",
    start: lit("2024-01-01"),
    end: lit("2024-12-31"),
  })
  .compile(db.printer())

// ALL — full history
db.selectFrom("users").forSystemTime({ kind: "all" }).compile(db.printer())
```

Supported modes: `as_of`, `from_to`, `between`, `contained_in`, `all`.

## Tree Shaking

Import only the dialect you need:

```ts
import { sumak } from "sumak"
import { pgDialect } from "sumak/pg"
import { mssqlDialect } from "sumak/mssql"
import { mysqlDialect } from "sumak/mysql"
import { sqliteDialect } from "sumak/sqlite"
import { serial, text } from "sumak/schema"
```

## Dialects

Same query, different SQL:

```ts
// PostgreSQL  → SELECT "id" FROM "users" WHERE ("id" = $1)
// MySQL       → SELECT `id` FROM `users` WHERE (`id` = ?)
// SQLite      → SELECT "id" FROM "users" WHERE ("id" = ?)
// MSSQL       → SELECT [id] FROM [users] WHERE ([id] = @p0)
```

### MSSQL Specifics

```ts
import { mssqlDialect } from "sumak/mssql"

const db = sumak({
  dialect: mssqlDialect(),
  tables: { ... },
})

// LIMIT → TOP N
// SELECT TOP 10 * FROM [users]

// LIMIT + OFFSET → OFFSET/FETCH
// SELECT * FROM [users] ORDER BY [id] ASC OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY

// RETURNING → OUTPUT INSERTED.*
// INSERT INTO [users] ([name]) OUTPUT INSERTED.* VALUES (@p0)

// DELETE RETURNING → OUTPUT DELETED.*
// DELETE FROM [users] OUTPUT DELETED.* WHERE ([id] = @p0)
```

## Plugins

```ts
import {
  WithSchemaPlugin,
  SoftDeletePlugin,
  CamelCasePlugin,
} from "sumak"

const db = sumak({
  dialect: pgDialect(),
  plugins: [
    new WithSchemaPlugin("public"),
    new SoftDeletePlugin({ tables: ["users"] }),
  ],
  tables: { ... },
})

// SELECT * FROM "public"."users" WHERE ("deleted_at" IS NULL)
```

## Hooks

```ts
// Query logging
db.hook("query:after", (ctx) => {
  console.log(`[SQL] ${ctx.query.sql}`)
})

// Add request tracing
db.hook("query:after", (ctx) => {
  return {
    ...ctx.query,
    sql: `${ctx.query.sql} /* request_id=${requestId} */`,
  }
})

// Modify AST before compilation
db.hook("select:before", (ctx) => {
  // Add tenant isolation, audit filters, etc.
})

// Transform results
db.hook("result:transform", (rows) => {
  return rows.map(toCamelCase)
})

// Unregister
const off = db.hook("query:before", handler)
off()
```

## Why sumak?

|                    | sumak             | Drizzle         | Kysely         |
| ------------------ | ----------------- | --------------- | -------------- |
| **Architecture**   | AST-first         | Template        | AST (98 nodes) |
| **Type inference** | Auto (no codegen) | Auto            | Manual DB type |
| **Plugin system**  | Hooks + plugins   | None            | Plugins only   |
| **SQL printer**    | Wadler algebra    | Template concat | String append  |
| **Dependencies**   | 0                 | 0               | 0              |
| **Node types**     | ~35 (focused)     | Config objects  | 98 (complex)   |
| **API style**      | Callback proxy    | Method chain    | Method chain   |

## Architecture

```
Schema → Builder → AST → Plugin/Hook → Printer → SQL
```

- **Schema Layer** — `defineTable()`, `ColumnType<S,I,U>`, auto type inference
- **Builder Layer** — `Sumak<DB>`, `TypedSelectBuilder<DB,TB,O>`, proxy-based expressions
- **AST Layer** — ~35 frozen node types, discriminated unions, visitor pattern
- **Plugin Layer** — `SumakPlugin` interface, `Hookable` lifecycle hooks
- **Printer Layer** — `BasePrinter` with 4 dialect subclasses (PG, MySQL, SQLite, MSSQL), Wadler document algebra

## License

[MIT](./LICENSE)
