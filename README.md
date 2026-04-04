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

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [SELECT](#select)
- [INSERT](#insert)
- [UPDATE](#update)
- [DELETE](#delete)
- [WHERE Conditions](#where-conditions)
- [Joins](#joins)
- [Expressions](#expressions)
- [Aggregates](#aggregates)
- [Window Functions](#window-functions)
- [SQL Functions](#sql-functions)
- [Subqueries](#subqueries)
- [Set Operations](#set-operations)
- [CTEs (WITH)](#ctes-with)
- [Conditional / Dynamic Queries](#conditional--dynamic-queries)
- [Raw SQL](#raw-sql)
- [ON CONFLICT / Upsert](#on-conflict--upsert)
- [MERGE](#merge-sql2003)
- [Row Locking](#row-locking)
- [Schema Builder (DDL)](#schema-builder-ddl)
- [Full-Text Search](#full-text-search)
- [Temporal Tables](#temporal-tables-sql2011)
- [Plugins](#plugins)
- [Hooks](#hooks)
- [Dialects](#dialects)
- [Architecture](#architecture)

---

## Install

```sh
npm install sumak
```

## Quick Start

Define your tables and create a typed instance:

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

That's it. `db` now knows every table, column, and type. All queries are fully type-checked.

---

## SELECT

```ts
// Basic select
db.selectFrom("users").select("id", "name").toSQL()
// SELECT "id", "name" FROM "users"

// Select all columns
db.selectFrom("users").selectAll().toSQL()

// With WHERE, ORDER BY, LIMIT, OFFSET
db.selectFrom("users")
  .select("id", "name")
  .where(({ age }) => age.gte(18))
  .orderBy("name")
  .limit(10)
  .offset(20)
  .toSQL()

// DISTINCT
db.selectFrom("users").select("name").distinct().toSQL()

// DISTINCT ON (PostgreSQL)
db.selectFrom("users")
  .selectAll()
  .distinctOn("dept")
  .orderBy("dept")
  .orderBy("salary", "DESC")
  .toSQL()
```

---

## INSERT

```ts
// Single row
db.insertInto("users").values({ name: "Alice", email: "alice@example.com" }).toSQL()

// Multiple rows
db.insertInto("users")
  .valuesMany([
    { name: "Alice", email: "a@b.com" },
    { name: "Bob", email: "b@b.com" },
  ])
  .toSQL()

// RETURNING
db.insertInto("users").values({ name: "Alice", email: "a@b.com" }).returningAll().toSQL()

// INSERT ... SELECT
const source = db.selectFrom("users").select("name", "email").build()
db.insertInto("archive").fromSelect(source).toSQL()

// DEFAULT VALUES
db.insertInto("users").defaultValues().toSQL()

// SQLite: INSERT OR IGNORE / INSERT OR REPLACE
db.insertInto("users").values({ name: "Alice" }).orIgnore().toSQL()
```

---

## UPDATE

```ts
// Basic update
db.update("users")
  .set({ active: false })
  .where(({ id }) => id.eq(1))
  .toSQL()

// SET with expression
db.update("users")
  .setExpr("name", val("Anonymous"))
  .where(({ active }) => active.eq(false))
  .toSQL()

// UPDATE ... FROM (PostgreSQL)
db.update("users")
  .set({ name: "Bob" })
  .from("posts")
  .where(({ id }) => id.eq(1))
  .toSQL()

// UPDATE with JOIN (MySQL)
db.update("orders").set({ total: 0 }).innerJoin("users", onExpr).toSQL()

// RETURNING
db.update("users")
  .set({ active: false })
  .where(({ id }) => id.eq(1))
  .returningAll()
  .toSQL()

// ORDER BY + LIMIT (MySQL)
db.update("users").set({ active: false }).orderBy("id").limit(lit(10)).toSQL()
```

---

## DELETE

```ts
db.deleteFrom("users")
  .where(({ id }) => id.eq(1))
  .toSQL()

// RETURNING
db.deleteFrom("users")
  .where(({ id }) => id.eq(1))
  .returning("id")
  .toSQL()

// DELETE ... USING (PostgreSQL)
db.deleteFrom("orders").using("users").where(onExpr).toSQL()

// DELETE with JOIN (MySQL)
db.deleteFrom("orders")
  .innerJoin("users", onExpr)
  .where(({ id }) => id.eq(1))
  .toSQL()
```

---

## WHERE Conditions

Every `.where()` takes a callback with typed column proxies.

### Comparisons

```ts
.where(({ age }) => age.eq(25))        // = 25
.where(({ age }) => age.neq(0))        // != 0
.where(({ age }) => age.gt(18))        // > 18
.where(({ age }) => age.gte(18))       // >= 18
.where(({ age }) => age.lt(65))        // < 65
.where(({ age }) => age.lte(65))       // <= 65
```

### Pattern Matching

```ts
.where(({ name }) => name.like("%ali%"))         // LIKE
.where(({ name }) => name.notLike("%bob%"))      // NOT LIKE
.where(({ name }) => name.ilike("%alice%"))      // ILIKE (PG)
.where(({ email }) => email.notIlike("%spam%"))  // NOT ILIKE
```

### Range & Lists

```ts
.where(({ age }) => age.between(18, 65))           // BETWEEN
.where(({ age }) => age.notBetween(0, 17))         // NOT BETWEEN
.where(({ age }) => age.betweenSymmetric(65, 18))  // BETWEEN SYMMETRIC (PG)
.where(({ id }) => id.in([1, 2, 3]))               // IN
.where(({ id }) => id.notIn([99, 100]))             // NOT IN
```

### Null Checks

```ts
.where(({ bio }) => bio.isNull())       // IS NULL
.where(({ email }) => email.isNotNull()) // IS NOT NULL
```

### Null-Safe Comparisons

```ts
.where(({ age }) => age.isDistinctFrom(null))      // IS DISTINCT FROM
.where(({ age }) => age.isNotDistinctFrom(25))     // IS NOT DISTINCT FROM
```

### IN Subquery

```ts
const deptIds = db
  .selectFrom("departments")
  .select("id")
  .build()

  .where(({ dept_id }) => dept_id.inSubquery(deptIds)) // IN (SELECT ...)
  .where(({ dept_id }) => dept_id.notInSubquery(deptIds)) // NOT IN (SELECT ...)
```

### Logical Combinators

```ts
// AND (variadic — 2 or more args)
.where(({ age, active }) =>
  and(age.gt(18), active.eq(true)),
)

// AND with 3+ conditions
.where(({ id, age, active }) =>
  and(id.gt(0), age.gt(18), active.eq(true)),
)

// OR (variadic)
.where(({ name, email }) =>
  or(name.like("%alice%"), email.like("%alice%")),
)

// NOT
.where(({ active }) => not(active.eq(true)))
```

### Multiple WHERE (implicit AND)

```ts
// Calling .where() multiple times ANDs conditions together
db.selectFrom("users")
  .select("id")
  .where(({ age }) => age.gt(18))
  .where(({ active }) => active.eq(true))
  .toSQL()
// WHERE ("age" > $1) AND ("active" = $2)
```

### Column-to-Column Comparisons

```ts
.where(({ price, cost }) => price.gtCol(cost))    // "price" > "cost"
.where(({ a, b }) => a.eqCol(b))                  // "a" = "b"
.where(({ a, b }) => a.neqCol(b))                 // "a" != "b"
.where(({ a, b }) => a.gteCol(b))                 // "a" >= "b"
.where(({ a, b }) => a.ltCol(b))                  // "a" < "b"
.where(({ a, b }) => a.lteCol(b))                 // "a" <= "b"
```

---

## Joins

```ts
// INNER JOIN
db.selectFrom("users")
  .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .select("id", "title")
  .toSQL()

// LEFT JOIN — joined columns become nullable
db.selectFrom("users")
  .leftJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .toSQL()

// RIGHT JOIN
db.selectFrom("users")
  .rightJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .toSQL()

// FULL JOIN — both sides nullable
db.selectFrom("users")
  .fullJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .toSQL()

// CROSS JOIN
db.selectFrom("users").crossJoin("posts").toSQL()

// LATERAL JOINs (correlated subqueries)
db.selectFrom("users").innerJoinLateral(subquery, "recent_posts", onExpr).toSQL()

db.selectFrom("users").leftJoinLateral(subquery, "recent_posts", onExpr).toSQL()

db.selectFrom("users").crossJoinLateral(subquery, "latest").toSQL()
```

---

## Expressions

### Computed Columns

```ts
import { val, cast, rawExpr } from "sumak"

// Add a computed column with alias
db.selectFrom("users").selectExpr(val("hello"), "greeting").toSQL()

// Multiple expressions at once
db.selectFrom("users")
  .selectExprs({
    total: count(),
    greeting: val("hello"),
  })
  .toSQL()

// CAST
db.selectFrom("users")
  .selectExpr(cast(val(42), "text"), "idAsText")
  .toSQL()
```

### Arithmetic

```ts
import { add, sub, mul, div, mod, neg } from "sumak"

db.selectFrom("orders").selectExpr(mul(col.price, col.qty), "total").toSQL()
// ("price" * "qty") AS "total"

db.selectFrom("orders")
  .selectExpr(add(col.price, val(10)), "adjusted")
  .toSQL()
```

### CASE / WHEN

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
  .toSQL()
```

### JSON Operations

```ts
import { jsonRef, jsonAgg, toJson, jsonBuildObject } from "sumak"

// Access: ->  (JSON object), ->> (text value)
db.selectFrom("users")
  .selectExpr(jsonRef(col.meta, "name", "->>"), "metaName")
  .toSQL()

// JSON_AGG / TO_JSON
db.selectFrom("users").selectExpr(jsonAgg(col.name), "namesJson").toSQL()

// JSON_BUILD_OBJECT
db.selectFrom("users")
  .selectExpr(jsonBuildObject(["name", col.name], ["age", col.age]), "obj")
  .toSQL()
```

### PostgreSQL Array Operators

```ts
import { arrayContains, arrayContainedBy, arrayOverlaps, rawExpr } from "sumak"

.where(() => arrayContains(rawExpr("tags"), rawExpr("ARRAY['sql']")))    // @>
.where(() => arrayContainedBy(rawExpr("tags"), rawExpr("ARRAY[...]")))   // <@
.where(() => arrayOverlaps(rawExpr("tags"), rawExpr("ARRAY['sql']")))    // &&
```

---

## Aggregates

```ts
import { count, countDistinct, sum, sumDistinct, avg, avgDistinct, min, max, coalesce } from "sumak"

db.selectFrom("users").selectExpr(count(), "total").toSQL()
db.selectFrom("users").selectExpr(countDistinct(col.dept), "uniqueDepts").toSQL()
db.selectFrom("orders").selectExpr(sumDistinct(col.amount), "uniqueSum").toSQL()
db.selectFrom("orders").selectExpr(avg(col.amount), "avgAmount").toSQL()

// COALESCE (variadic)
db.selectFrom("users")
  .selectExpr(coalesce(col.nick, col.name, val("Anonymous")), "displayName")
  .toSQL()
```

### Aggregate with FILTER (PostgreSQL)

```ts
import { filter, count } from "sumak"

db.selectFrom("users").selectExpr(filter(count(), activeExpr), "activeCount").toSQL()
// COUNT(*) FILTER (WHERE ...)
```

### Aggregate with ORDER BY

```ts
import { stringAgg, arrayAgg } from "sumak"

// STRING_AGG with ORDER BY
db.selectFrom("users")
  .selectExpr(stringAgg(col.name, ", ", [{ expr: col.name, direction: "ASC" }]), "names")
  .toSQL()
// STRING_AGG("name", ', ' ORDER BY "name" ASC)

// ARRAY_AGG
db.selectFrom("users").selectExpr(arrayAgg(col.id), "ids").toSQL()
```

---

## Window Functions

```ts
import { over, rowNumber, rank, denseRank, lag, lead, ntile, count, sum } from "sumak"

// ROW_NUMBER
db.selectFrom("employees")
  .selectExpr(
    over(rowNumber(), (w) => w.partitionBy("dept").orderBy("salary", "DESC")),
    "rn",
  )
  .toSQL()

// RANK / DENSE_RANK
over(rank(), (w) => w.orderBy("score", "DESC"))
over(denseRank(), (w) => w.orderBy("score", "DESC"))

// Running total with frame
over(sum(col.amount), (w) =>
  w
    .partitionBy("userId")
    .orderBy("createdAt")
    .rows({ type: "unbounded_preceding" }, { type: "current_row" }),
)

// RANGE / GROUPS frames
over(count(), (w) =>
  w.orderBy("salary").range({ type: "preceding", value: 100 }, { type: "following", value: 100 }),
)

// LAG / LEAD / NTILE
over(lag(col.price, 1), (w) => w.orderBy("date"))
over(lead(col.price, 1), (w) => w.orderBy("date"))
over(ntile(4), (w) => w.orderBy("salary", "DESC"))
```

---

## SQL Functions

### String

```ts
import { upper, lower, concat, substring, trim, length } from "sumak"

upper(col.name) // UPPER("name")
lower(col.email) // LOWER("email")
concat(col.first, val(" "), col.last) // CONCAT(...)
substring(col.name, 1, 3) // SUBSTRING("name", 1, 3)
trim(col.name) // TRIM("name")
length(col.name) // LENGTH("name")
```

### Numeric

```ts
import { abs, round, ceil, floor, greatest, least } from "sumak"

abs(col.balance) // ABS("balance")
round(col.price, 2) // ROUND("price", 2)
ceil(col.amount) // CEIL("amount")
floor(col.amount) // FLOOR("amount")
greatest(col.a, col.b) // GREATEST("a", "b")
least(col.a, col.b) // LEAST("a", "b")
```

### Conditional

```ts
import { nullif, coalesce } from "sumak"

nullif(col.age, val(0)) // NULLIF("age", 0)
coalesce(col.nick, col.name, val("Anonymous")) // COALESCE(...)
```

### Date/Time

```ts
import { now, currentTimestamp } from "sumak"

now() // NOW()
currentTimestamp() // CURRENT_TIMESTAMP()
```

---

## Subqueries

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
  .toSQL()
```

### Derived Tables (Subquery in FROM)

```ts
const sub = db
  .selectFrom("users")
  .select("id", "name")
  .where(({ age }) => age.gt(18))

db.selectFromSubquery(sub, "adults").selectAll().toSQL()
// SELECT * FROM (SELECT ...) AS "adults"
```

### IN Subquery

```ts
const deptIds = db.selectFrom("departments").select("id").build()

db.selectFrom("users")
  .where(({ dept_id }) => dept_id.inSubquery(deptIds))
  .toSQL()
```

---

## Set Operations

```ts
const active = db
  .selectFrom("users")
  .select("id")
  .where(({ active }) => active.eq(true))
const premium = db
  .selectFrom("users")
  .select("id")
  .where(({ tier }) => tier.eq("premium"))

active.union(premium).toSQL() // UNION
active.unionAll(premium).toSQL() // UNION ALL
active.intersect(premium).toSQL() // INTERSECT
active.intersectAll(premium).toSQL() // INTERSECT ALL
active.except(premium).toSQL() // EXCEPT
active.exceptAll(premium).toSQL() // EXCEPT ALL
```

---

## CTEs (WITH)

```ts
const activeCte = db
  .selectFrom("users")
  .where(({ active }) => active.eq(true))
  .build()

db.selectFrom("users").with("active_users", activeCte).toSQL()

// Recursive CTE
db.selectFrom("categories").with("tree", recursiveQuery, true).toSQL()
```

---

## Conditional / Dynamic Queries

### `$if()` — conditional clause

```ts
const withFilter = true
const withOrder = false

db.selectFrom("users")
  .select("id", "name")
  .$if(withFilter, (qb) => qb.where(({ age }) => age.gt(18)))
  .$if(withOrder, (qb) => qb.orderBy("name"))
  .toSQL()
// WHERE applied, ORDER BY skipped
```

### `$call()` — reusable query fragments

```ts
const withPagination = (qb) => qb.limit(10).offset(20)
const onlyActive = (qb) => qb.where(({ active }) => active.eq(true))

db.selectFrom("users").select("id", "name").$call(onlyActive).$call(withPagination).toSQL()
```

### `clear*()` — reset clauses

```ts
db.selectFrom("users")
  .select("id")
  .orderBy("name")
  .clearOrderBy() // removes ORDER BY
  .orderBy("id", "DESC") // re-add different order
  .toSQL()
```

Available: `clearWhere()`, `clearOrderBy()`, `clearLimit()`, `clearOffset()`, `clearGroupBy()`, `clearHaving()`, `clearSelect()`.

---

## Raw SQL

### `sql` tagged template

```ts
import { sql } from "sumak"

// Primitives are parameterized
sql`SELECT * FROM users WHERE name = ${"Alice"}`
// params: ["Alice"]

// Expressions are inlined
sql`SELECT * FROM users WHERE active = ${val(true)}`
// → ... WHERE active = TRUE

// Helpers
sql`SELECT ${sql.ref("id")} FROM ${sql.table("users", "public")}`
// → SELECT "id" FROM "public"."users"

// In queries
db.selectFrom("users")
  .selectExpr(sql`CURRENT_DATE`, "today")
  .toSQL()
```

### `rawExpr()` escape hatch

```ts
import { rawExpr } from "sumak"

// In WHERE
db.selectFrom("users")
  .where(() => rawExpr<boolean>("age > 18"))
  .toSQL()

// In SELECT
db.selectFrom("users").selectExpr(rawExpr<number>("EXTRACT(YEAR FROM created_at)"), "year").toSQL()
```

---

## ON CONFLICT / Upsert

```ts
// PostgreSQL: ON CONFLICT DO NOTHING
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictDoNothing("email")
  .toSQL()

// ON CONFLICT DO UPDATE (with Expression)
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictDoUpdate(["email"], [{ column: "name", value: val("Updated") }])
  .toSQL()

// ON CONFLICT DO UPDATE (with plain object — auto-parameterized)
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictDoUpdateSet(["email"], { name: "Alice Updated" })
  .toSQL()

// ON CONFLICT ON CONSTRAINT
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictConstraintDoNothing("users_email_key")
  .toSQL()

// MySQL: ON DUPLICATE KEY UPDATE
db.insertInto("users")
  .values({ name: "Alice" })
  .onDuplicateKeyUpdate([{ column: "name", value: val("Alice") }])
  .toSQL()
```

---

## MERGE (SQL:2003)

```ts
db.mergeInto("users", "staging", "s", ({ target, source }) => target.id.eqCol(source.id))
  .whenMatchedThenUpdate({ name: "updated" })
  .whenNotMatchedThenInsert({ name: "Alice", email: "a@b.com" })
  .toSQL()

// Conditional delete
db.mergeInto("users", "staging", "s", ({ target, source }) => target.id.eqCol(source.id))
  .whenMatchedThenDelete()
  .toSQL()
```

---

## Row Locking

```ts
db.selectFrom("users").select("id").forUpdate().toSQL() // FOR UPDATE
db.selectFrom("users").select("id").forShare().toSQL() // FOR SHARE
db.selectFrom("users").select("id").forNoKeyUpdate().toSQL() // FOR NO KEY UPDATE (PG)
db.selectFrom("users").select("id").forKeyShare().toSQL() // FOR KEY SHARE (PG)

// Modifiers
db.selectFrom("users").select("id").forUpdate().skipLocked().toSQL() // SKIP LOCKED
db.selectFrom("users").select("id").forUpdate().noWait().toSQL() // NOWAIT
```

---

## EXPLAIN

```ts
db.selectFrom("users").select("id").explain().toSQL()
// EXPLAIN SELECT "id" FROM "users"

db.selectFrom("users").select("id").explain({ analyze: true }).toSQL()
// EXPLAIN ANALYZE SELECT ...

db.selectFrom("users").select("id").explain({ format: "JSON" }).toSQL()
// EXPLAIN (FORMAT JSON) SELECT ...
```

---

## Schema Builder (DDL)

The schema builder generates DDL SQL (CREATE, ALTER, DROP). It is separate from the query builder — you use `db.compileDDL(node)` to compile DDL nodes.

### CREATE TABLE

```ts
db.schema
  .createTable("users")
  .ifNotExists()
  .addColumn("id", "serial", (c) => c.primaryKey())
  .addColumn("name", "varchar(255)", (c) => c.notNull())
  .addColumn("email", "varchar", (c) => c.unique().notNull())
  .addColumn("active", "boolean", (c) => c.defaultTo(lit(true)))
  .build()

// Foreign key with ON DELETE CASCADE
db.schema
  .createTable("posts")
  .addColumn("id", "serial", (c) => c.primaryKey())
  .addColumn("user_id", "integer", (c) => c.notNull().references("users", "id").onDelete("CASCADE"))
  .build()

// Composite primary key
db.schema
  .createTable("order_items")
  .addColumn("order_id", "integer")
  .addColumn("product_id", "integer")
  .addPrimaryKeyConstraint("pk_order_items", ["order_id", "product_id"])
  .build()
```

### ALTER TABLE

```ts
db.schema
  .alterTable("users")
  .addColumn("age", "integer", (c) => c.notNull())
  .build()

db.schema.alterTable("users").dropColumn("age").build()
db.schema.alterTable("users").renameColumn("name", "full_name").build()
db.schema.alterTable("users").renameTo("people").build()

db.schema
  .alterTable("users")
  .alterColumn("age", { type: "set_data_type", dataType: "bigint" })
  .build()
db.schema.alterTable("users").alterColumn("name", { type: "set_not_null" }).build()
```

### CREATE INDEX

```ts
db.schema.createIndex("idx_users_name").on("users").column("name").build()
db.schema.createIndex("uq_email").unique().on("users").column("email").build()

// Multi-column with direction
db.schema
  .createIndex("idx_multi")
  .on("users")
  .column("last_name", "ASC")
  .column("age", "DESC")
  .build()

// GIN index (PG)
db.schema.createIndex("idx_tags").on("posts").column("tags").using("gin").build()

// Partial index
db.schema
  .createIndex("idx_active")
  .on("users")
  .column("email")
  .where(rawExpr("active = true"))
  .build()
```

### CREATE VIEW

```ts
db.schema.createView("active_users").asSelect(selectQuery).build()
db.schema.createView("stats").materialized().asSelect(selectQuery).build()
db.schema.createView("my_view").orReplace().columns("id", "name").asSelect(selectQuery).build()
```

### DROP

```ts
db.schema.dropTable("users").ifExists().cascade().build()
db.schema.dropIndex("idx_name").ifExists().build()
db.schema.dropView("my_view").materialized().ifExists().build()
```

### Auto-Generate from Schema

The schema you pass to `sumak({ tables })` can auto-generate CREATE TABLE SQL:

```ts
const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      userId: integer().references("users", "id"),
    },
  },
})

const ddl = db.generateDDL()
// [
//   { sql: 'CREATE TABLE "users" ("id" serial PRIMARY KEY NOT NULL, "name" text NOT NULL, "email" text NOT NULL)', params: [] },
//   { sql: 'CREATE TABLE "posts" ("id" serial PRIMARY KEY NOT NULL, "title" text NOT NULL, "userId" integer REFERENCES "users"("id"))', params: [] },
// ]

// With IF NOT EXISTS
const safeDDL = db.generateDDL({ ifNotExists: true })
```

> Compile any DDL node: `db.compileDDL(node)` returns `{ sql, params }`.

---

## Full-Text Search

Dialect-aware — same API, different SQL per dialect:

```ts
import { textSearch, val } from "sumak"

// PostgreSQL: to_tsvector("name") @@ to_tsquery('alice')
db.selectFrom("users")
  .where(({ name }) => textSearch([name.toExpr()], val("alice")))
  .toSQL()

// MySQL: MATCH(`name`) AGAINST(? IN BOOLEAN MODE)
// SQLite: ("name" MATCH ?)
// MSSQL: CONTAINS(([name]), @p0)
```

---

## Temporal Tables (SQL:2011)

```ts
// Point-in-time query
db.selectFrom("users")
  .forSystemTime({ kind: "as_of", timestamp: lit("2024-01-01") })
  .toSQL()

// Time range
db.selectFrom("users")
  .forSystemTime({ kind: "between", start: lit("2024-01-01"), end: lit("2024-12-31") })
  .toSQL()

// Full history
db.selectFrom("users").forSystemTime({ kind: "all" }).toSQL()
```

Modes: `as_of`, `from_to`, `between`, `contained_in`, `all`.

---

## Plugins

### WithSchemaPlugin

```ts
const db = sumak({
  plugins: [new WithSchemaPlugin("public")],
  ...
})
// SELECT * FROM "public"."users"
```

### SoftDeletePlugin

```ts
// Mode "convert" (default) — DELETE becomes UPDATE SET deleted_at = NOW()
const db = sumak({
  plugins: [new SoftDeletePlugin({ tables: ["users"], mode: "convert" })],
  ...
})

db.deleteFrom("users").where(({ id }) => id.eq(1)).toSQL()
// UPDATE "users" SET "deleted_at" = NOW() WHERE ("id" = $1) AND ("deleted_at" IS NULL)

// Mode "filter" — just adds WHERE deleted_at IS NULL (no DELETE conversion)
new SoftDeletePlugin({ tables: ["users"], mode: "filter" })
```

### AuditTimestampPlugin

```ts
// Auto-inject created_at/updated_at timestamps
const db = sumak({
  plugins: [new AuditTimestampPlugin({ tables: ["users"] })],
  ...
})

db.insertInto("users").values({ name: "Alice" }).toSQL()
// INSERT INTO "users" ("name", "created_at", "updated_at") VALUES ($1, NOW(), NOW())

db.update("users").set({ name: "Bob" }).where(({ id }) => id.eq(1)).toSQL()
// UPDATE "users" SET "name" = $1, "updated_at" = NOW() WHERE ...
```

### MultiTenantPlugin

```ts
// Auto-inject tenant_id on all queries
const db = sumak({
  plugins: [new MultiTenantPlugin({ tables: ["users", "posts"], tenantId: 42 })],
  ...
})

db.selectFrom("users").select("id").toSQL()
// SELECT "id" FROM "users" WHERE ("tenant_id" = $1)  — params: [42]

db.insertInto("users").values({ name: "Alice" }).toSQL()
// INSERT INTO "users" ("name", "tenant_id") VALUES ($1, $2)  — params: ["Alice", 42]
```

### QueryLimitPlugin

```ts
// Auto-inject LIMIT on unbounded SELECTs
const db = sumak({
  plugins: [new QueryLimitPlugin({ maxRows: 1000 })],
  ...
})

db.selectFrom("users").select("id").toSQL()
// SELECT "id" FROM "users" LIMIT 1000

db.selectFrom("users").select("id").limit(5).toSQL()
// SELECT "id" FROM "users" LIMIT 5  — explicit limit preserved
```

### CamelCasePlugin

```ts
// Transform snake_case result columns to camelCase
const db = sumak({
  plugins: [new CamelCasePlugin()],
  ...
})
```

### OptimisticLockPlugin

```ts
// Auto-inject WHERE version = N and SET version = version + 1 on UPDATE
const db = sumak({
  plugins: [new OptimisticLockPlugin({ tables: ["users"], currentVersion: 3 })],
  ...
})

db.update("users").set({ name: "Bob" }).where(({ id }) => id.eq(1)).toSQL()
// UPDATE "users" SET "name" = $1, "version" = ("version" + 1)
//   WHERE ("id" = $2) AND ("version" = $3)  — params: ["Bob", 1, 3]
```

### DataMaskingPlugin

```ts
// Mask sensitive data in query results
const plugin = new DataMaskingPlugin({
  rules: [
    { column: "email", mask: "email" },    // "alice@example.com" → "al***@example.com"
    { column: "phone", mask: "phone" },    // "+1234567890" → "***7890"
    { column: "name", mask: "partial" },   // "John Doe" → "Jo***"
    { column: "ssn", mask: (v) => `***-**-${String(v).slice(-4)}` },  // custom
  ],
})

const db = sumak({ plugins: [plugin], ... })
```

### Combining Plugins

```ts
const db = sumak({
  dialect: pgDialect(),
  plugins: [
    new WithSchemaPlugin("public"),
    new SoftDeletePlugin({ tables: ["users"] }),
    new AuditTimestampPlugin({ tables: ["users", "posts"] }),
    new MultiTenantPlugin({ tables: ["users", "posts"], tenantId: currentTenantId }),
    new QueryLimitPlugin({ maxRows: 5000 }),
  ],
  tables: { ... },
})
```

---

## Hooks

```ts
// Query logging
db.hook("query:after", (ctx) => {
  console.log(`[SQL] ${ctx.query.sql}`)
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

---

## Dialects

4 dialects supported. Same query, different SQL:

```ts
// PostgreSQL  → SELECT "id" FROM "users" WHERE ("id" = $1)
// MySQL       → SELECT `id` FROM `users` WHERE (`id` = ?)
// SQLite      → SELECT "id" FROM "users" WHERE ("id" = ?)
// MSSQL       → SELECT [id] FROM [users] WHERE ([id] = @p0)
```

```ts
import { pgDialect } from "sumak/pg"
import { mysqlDialect } from "sumak/mysql"
import { sqliteDialect } from "sumak/sqlite"
import { mssqlDialect } from "sumak/mssql"
```

### Tree Shaking

Import only the dialect you need — unused dialects are eliminated:

```ts
import { sumak } from "sumak"
import { pgDialect } from "sumak/pg"
import { serial, text } from "sumak/schema"
```

---

## Architecture

sumak uses a 5-layer pipeline. Your code never touches SQL strings — everything flows through an AST.

```
┌─────────────────────────────────────────────────────────────────┐
│  1. SCHEMA                                                      │
│     sumak({ dialect, tables: { users: { id: serial(), ... } } })│
│     → DB type auto-inferred, zero codegen                       │
├─────────────────────────────────────────────────────────────────┤
│  2. BUILDER                                                     │
│     db.selectFrom("users").select("id").where(...)              │
│     → Immutable, chainable, fully type-checked                  │
├─────────────────────────────────────────────────────────────────┤
│  3. AST                                                         │
│     .build() → SelectNode (frozen, discriminated union)         │
│     → ~40 node types, Object.freeze on all outputs              │
├─────────────────────────────────────────────────────────────────┤
│  4. PLUGIN / HOOK                                               │
│     Plugin.transformNode() → Hook "query:before"                │
│     → AST rewriting, tenant isolation, soft delete, logging     │
├─────────────────────────────────────────────────────────────────┤
│  5. PRINTER                                                     │
│     .toSQL() → { sql: "SELECT ...", params: [...] }             │
│     → Dialect-specific: PG ($1), MySQL (?), MSSQL (@p0)        │
└─────────────────────────────────────────────────────────────────┘
```

### Why AST-first?

The query is never a string until the very last step. This means:

- **Plugins can rewrite queries** — add WHERE clauses, prefix schemas, transform joins
- **Hooks can inspect/modify** — logging, tracing, tenant isolation
- **Printers are swappable** — same AST, different SQL per dialect
- **No SQL injection** — values are always parameterized

### Key design decisions

- **Params at print time** — no global state, no index tracking during build
- **Immutable builders** — every method returns a new instance
- **Proxy-based column access** — `({ age }) => age.gt(18)` with full type safety
- **Phantom types** — `Expression<T>` carries type info with zero runtime cost

---

## Acknowledgments

sumak wouldn't exist without the incredible work of these projects:

- **[Kysely](https://github.com/kysely-org/kysely)** — Pioneered the AST-first approach for TypeScript query builders. The `DB/TB/O` generic threading pattern, immutable builder design, and visitor-based printer architecture are directly inspired by Kysely.
- **[Drizzle ORM](https://github.com/drizzle-team/drizzle-orm)** — Proved that schema-as-code (no codegen) is the right developer experience. The `defineTable()` + column builder pattern in sumak follows Drizzle's lead.
- **[JOOQ](https://github.com/jOOQ/jOOQ)** — The original AST-first SQL builder (Java). Showed that a clean AST layer makes multi-dialect support elegant.
- **[SQLAlchemy](https://github.com/sqlalchemy/sqlalchemy)** — Demonstrated that separating the expression layer from the ORM layer gives maximum flexibility.

---

## License

[MIT](./LICENSE)
