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
db.selectFrom("users").select("id", "name").compile(db.printer())
// SELECT "id", "name" FROM "users"

// Select all columns
db.selectFrom("users").selectAll().compile(db.printer())

// With WHERE, ORDER BY, LIMIT, OFFSET
db.selectFrom("users")
  .select("id", "name")
  .where(({ age }) => age.gte(18))
  .orderBy("name")
  .limit(10)
  .offset(20)
  .compile(db.printer())

// DISTINCT
db.selectFrom("users").select("name").distinct().compile(db.printer())

// DISTINCT ON (PostgreSQL)
db.selectFrom("users")
  .selectAll()
  .distinctOn("dept")
  .orderBy("dept")
  .orderBy("salary", "DESC")
  .compile(db.printer())
```

---

## INSERT

```ts
// Single row
db.insertInto("users").values({ name: "Alice", email: "alice@example.com" }).compile(db.printer())

// Multiple rows
db.insertInto("users")
  .valuesMany([
    { name: "Alice", email: "a@b.com" },
    { name: "Bob", email: "b@b.com" },
  ])
  .compile(db.printer())

// RETURNING
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .returningAll()
  .compile(db.printer())

// INSERT ... SELECT
const source = db.selectFrom("users").select("name", "email").build()
db.insertInto("archive").fromSelect(source).compile(db.printer())

// DEFAULT VALUES
db.insertInto("users").defaultValues().compile(db.printer())

// SQLite: INSERT OR IGNORE / INSERT OR REPLACE
db.insertInto("users").values({ name: "Alice" }).orIgnore().compile(db.printer())
```

---

## UPDATE

```ts
// Basic update
db.update("users")
  .set({ active: false })
  .where(({ id }) => id.eq(1))
  .compile(db.printer())

// SET with expression
db.update("users")
  .setExpr("name", val("Anonymous"))
  .where(({ active }) => active.eq(false))
  .compile(db.printer())

// UPDATE ... FROM (PostgreSQL)
db.update("users")
  .set({ name: "Bob" })
  .from("posts")
  .where(({ id }) => id.eq(1))
  .compile(db.printer())

// UPDATE with JOIN (MySQL)
db.update("orders").set({ total: 0 }).innerJoin("users", onExpr).compile(db.printer())

// RETURNING
db.update("users")
  .set({ active: false })
  .where(({ id }) => id.eq(1))
  .returningAll()
  .compile(db.printer())

// ORDER BY + LIMIT (MySQL)
db.update("users").set({ active: false }).orderBy("id").limit(lit(10)).compile(db.printer())
```

---

## DELETE

```ts
db.deleteFrom("users")
  .where(({ id }) => id.eq(1))
  .compile(db.printer())

// RETURNING
db.deleteFrom("users")
  .where(({ id }) => id.eq(1))
  .returning("id")
  .compile(db.printer())

// DELETE ... USING (PostgreSQL)
db.deleteFrom("orders").using("users").where(onExpr).compile(db.printer())

// DELETE with JOIN (MySQL)
db.deleteFrom("orders")
  .innerJoin("users", onExpr)
  .where(({ id }) => id.eq(1))
  .compile(db.printer())
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
  .compile(db.printer())
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
  .compile(db.printer())

// LEFT JOIN — joined columns become nullable
db.selectFrom("users")
  .leftJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .compile(db.printer())

// RIGHT JOIN
db.selectFrom("users")
  .rightJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .compile(db.printer())

// FULL JOIN — both sides nullable
db.selectFrom("users")
  .fullJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .compile(db.printer())

// CROSS JOIN
db.selectFrom("users").crossJoin("posts").compile(db.printer())

// LATERAL JOINs (correlated subqueries)
db.selectFrom("users").innerJoinLateral(subquery, "recent_posts", onExpr).compile(db.printer())

db.selectFrom("users").leftJoinLateral(subquery, "recent_posts", onExpr).compile(db.printer())

db.selectFrom("users").crossJoinLateral(subquery, "latest").compile(db.printer())
```

---

## Expressions

### Computed Columns

```ts
import { val, cast, rawExpr } from "sumak"

// Add a computed column with alias
db.selectFrom("users").selectExpr(val("hello"), "greeting").compile(db.printer())

// Multiple expressions at once
db.selectFrom("users")
  .selectExprs({
    total: count(),
    greeting: val("hello"),
  })
  .compile(db.printer())

// CAST
db.selectFrom("users")
  .selectExpr(cast(val(42), "text"), "idAsText")
  .compile(db.printer())
```

### Arithmetic

```ts
import { add, sub, mul, div, mod, neg } from "sumak"

db.selectFrom("orders").selectExpr(mul(col.price, col.qty), "total").compile(db.printer())
// ("price" * "qty") AS "total"

db.selectFrom("orders")
  .selectExpr(add(col.price, val(10)), "adjusted")
  .compile(db.printer())
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
  .compile(db.printer())
```

### JSON Operations

```ts
import { jsonRef, jsonAgg, toJson, jsonBuildObject } from "sumak"

// Access: ->  (JSON object), ->> (text value)
db.selectFrom("users")
  .selectExpr(jsonRef(col.meta, "name", "->>"), "metaName")
  .compile(db.printer())

// JSON_AGG / TO_JSON
db.selectFrom("users").selectExpr(jsonAgg(col.name), "namesJson").compile(db.printer())

// JSON_BUILD_OBJECT
db.selectFrom("users")
  .selectExpr(jsonBuildObject(["name", col.name], ["age", col.age]), "obj")
  .compile(db.printer())
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

db.selectFrom("users").selectExpr(count(), "total").compile(db.printer())
db.selectFrom("users").selectExpr(countDistinct(col.dept), "uniqueDepts").compile(db.printer())
db.selectFrom("orders").selectExpr(sumDistinct(col.amount), "uniqueSum").compile(db.printer())
db.selectFrom("orders").selectExpr(avg(col.amount), "avgAmount").compile(db.printer())

// COALESCE (variadic)
db.selectFrom("users")
  .selectExpr(coalesce(col.nick, col.name, val("Anonymous")), "displayName")
  .compile(db.printer())
```

### Aggregate with FILTER (PostgreSQL)

```ts
import { filter, count } from "sumak"

db.selectFrom("users").selectExpr(filter(count(), activeExpr), "activeCount").compile(db.printer())
// COUNT(*) FILTER (WHERE ...)
```

### Aggregate with ORDER BY

```ts
import { stringAgg, arrayAgg } from "sumak"

// STRING_AGG with ORDER BY
db.selectFrom("users")
  .selectExpr(stringAgg(col.name, ", ", [{ expr: col.name, direction: "ASC" }]), "names")
  .compile(db.printer())
// STRING_AGG("name", ', ' ORDER BY "name" ASC)

// ARRAY_AGG
db.selectFrom("users").selectExpr(arrayAgg(col.id), "ids").compile(db.printer())
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
  .compile(db.printer())

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
  .compile(db.printer())
```

### Derived Tables (Subquery in FROM)

```ts
const sub = db
  .selectFrom("users")
  .select("id", "name")
  .where(({ age }) => age.gt(18))

db.selectFromSubquery(sub, "adults").selectAll().compile(db.printer())
// SELECT * FROM (SELECT ...) AS "adults"
```

### IN Subquery

```ts
const deptIds = db.selectFrom("departments").select("id").build()

db.selectFrom("users")
  .where(({ dept_id }) => dept_id.inSubquery(deptIds))
  .compile(db.printer())
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

active.union(premium).compile(db.printer()) // UNION
active.unionAll(premium).compile(db.printer()) // UNION ALL
active.intersect(premium).compile(db.printer()) // INTERSECT
active.intersectAll(premium).compile(db.printer()) // INTERSECT ALL
active.except(premium).compile(db.printer()) // EXCEPT
active.exceptAll(premium).compile(db.printer()) // EXCEPT ALL
```

---

## CTEs (WITH)

```ts
const activeCte = db
  .selectFrom("users")
  .where(({ active }) => active.eq(true))
  .build()

db.selectFrom("users").with("active_users", activeCte).compile(db.printer())

// Recursive CTE
db.selectFrom("categories").with("tree", recursiveQuery, true).compile(db.printer())
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
  .compile(db.printer())
// WHERE applied, ORDER BY skipped
```

### `$call()` — reusable query fragments

```ts
const withPagination = (qb) => qb.limit(10).offset(20)
const onlyActive = (qb) => qb.where(({ active }) => active.eq(true))

db.selectFrom("users")
  .select("id", "name")
  .$call(onlyActive)
  .$call(withPagination)
  .compile(db.printer())
```

### `clear*()` — reset clauses

```ts
db.selectFrom("users")
  .select("id")
  .orderBy("name")
  .clearOrderBy() // removes ORDER BY
  .orderBy("id", "DESC") // re-add different order
  .compile(db.printer())
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
  .compile(db.printer())
```

### `rawExpr()` escape hatch

```ts
import { rawExpr } from "sumak"

// In WHERE
db.selectFrom("users")
  .where(() => rawExpr<boolean>("age > 18"))
  .compile(db.printer())

// In SELECT
db.selectFrom("users")
  .selectExpr(rawExpr<number>("EXTRACT(YEAR FROM created_at)"), "year")
  .compile(db.printer())
```

---

## ON CONFLICT / Upsert

```ts
// PostgreSQL: ON CONFLICT DO NOTHING
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictDoNothing("email")
  .compile(db.printer())

// ON CONFLICT DO UPDATE (with Expression)
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictDoUpdate(["email"], [{ column: "name", value: val("Updated") }])
  .compile(db.printer())

// ON CONFLICT DO UPDATE (with plain object — auto-parameterized)
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictDoUpdateSet(["email"], { name: "Alice Updated" })
  .compile(db.printer())

// ON CONFLICT ON CONSTRAINT
db.insertInto("users")
  .values({ name: "Alice", email: "a@b.com" })
  .onConflictConstraintDoNothing("users_email_key")
  .compile(db.printer())

// MySQL: ON DUPLICATE KEY UPDATE
db.insertInto("users")
  .values({ name: "Alice" })
  .onDuplicateKeyUpdate([{ column: "name", value: val("Alice") }])
  .compile(db.printer())
```

---

## MERGE (SQL:2003)

```ts
db.mergeInto("users", "staging", "s", ({ target, source }) => target.id.eqCol(source.id))
  .whenMatchedThenUpdate({ name: "updated" })
  .whenNotMatchedThenInsert({ name: "Alice", email: "a@b.com" })
  .compile(db.printer())

// Conditional delete
db.mergeInto("users", "staging", "s", ({ target, source }) => target.id.eqCol(source.id))
  .whenMatchedThenDelete()
  .compile(db.printer())
```

---

## Row Locking

```ts
db.selectFrom("users").select("id").forUpdate().compile(db.printer()) // FOR UPDATE
db.selectFrom("users").select("id").forShare().compile(db.printer()) // FOR SHARE
db.selectFrom("users").select("id").forNoKeyUpdate().compile(db.printer()) // FOR NO KEY UPDATE (PG)
db.selectFrom("users").select("id").forKeyShare().compile(db.printer()) // FOR KEY SHARE (PG)

// Modifiers
db.selectFrom("users").select("id").forUpdate().skipLocked().compile(db.printer()) // SKIP LOCKED
db.selectFrom("users").select("id").forUpdate().noWait().compile(db.printer()) // NOWAIT
```

---

## EXPLAIN

```ts
db.selectFrom("users").select("id").explain().compile(db.printer())
// EXPLAIN SELECT "id" FROM "users"

db.selectFrom("users").select("id").explain({ analyze: true }).compile(db.printer())
// EXPLAIN ANALYZE SELECT ...

db.selectFrom("users").select("id").explain({ format: "JSON" }).compile(db.printer())
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

> Compile DDL: `db.compileDDL(node)` returns `{ sql, params }`.

---

## Full-Text Search

Dialect-aware — same API, different SQL per dialect:

```ts
import { textSearch, val } from "sumak"

// PostgreSQL: to_tsvector("name") @@ to_tsquery('alice')
db.selectFrom("users")
  .where(({ name }) => textSearch([name.toExpr()], val("alice")))
  .compile(db.printer())

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
  .compile(db.printer())

// Time range
db.selectFrom("users")
  .forSystemTime({ kind: "between", start: lit("2024-01-01"), end: lit("2024-12-31") })
  .compile(db.printer())

// Full history
db.selectFrom("users").forSystemTime({ kind: "all" }).compile(db.printer())
```

Modes: `as_of`, `from_to`, `between`, `contained_in`, `all`.

---

## Plugins

```ts
import { WithSchemaPlugin, SoftDeletePlugin, CamelCasePlugin } from "sumak"

const db = sumak({
  dialect: pgDialect(),
  plugins: [
    new WithSchemaPlugin("public"),      // auto "public"."users"
    new SoftDeletePlugin({ tables: ["users"] }), // auto WHERE deleted_at IS NULL
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

```
User Code
  │
  ├── sumak({ dialect, tables })      ← DB type inferred
  │
  ├── db.selectFrom("users")          ← TypedSelectBuilder<DB, "users", O>
  │     .select("id", "name")         ← O narrows to Pick<O, "id"|"name">
  │     .where(({ age }) => age.gt(18))
  │     .build()                       ← SelectNode (frozen AST)
  │
  ├── db.compile(node)                ← Plugin → Hooks → Printer
  │
  └── { sql, params }                ← Parameterized output
```

**5 layers:**

- **Schema** — `defineTable()`, `ColumnType<S,I,U>`, auto type inference
- **Builder** — `TypedSelectBuilder<DB,TB,O>`, proxy-based expressions
- **AST** — Frozen node types, discriminated unions, visitor pattern
- **Plugin/Hook** — `SumakPlugin`, `Hookable` lifecycle hooks
- **Printer** — `BasePrinter` + 4 dialect subclasses, Wadler document algebra

|                    | sumak                 | Drizzle     | Kysely         |
| ------------------ | --------------------- | ----------- | -------------- |
| **Architecture**   | AST-first             | Template    | AST (98 nodes) |
| **Type inference** | Auto (no codegen)     | Auto        | Manual DB type |
| **Plugin system**  | Hooks + plugins       | None        | Plugins only   |
| **DDL support**    | Full (schema builder) | drizzle-kit | Full           |
| **Dependencies**   | 0                     | 0           | 0              |

---

## License

[MIT](./LICENSE)
