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

## Statistics and regression aggregates

Univariate dispersion (`stddev`, `variance`, plus the explicit `_pop` / `_samp` variants) emits the SQL-standard names on PG, MySQL, and SQLite. **MSSQL is excluded** — T-SQL's native spellings are `STDEV` / `STDEVP` / `VAR` / `VARP` with no `STDDEV_*` / `VARIANCE_*` aliases, so the standard name is a parse error there; reach for `sqlFn("STDEV", expr)` / `sqlFn("VARP", expr)` directly if you need MSSQL coverage. Use them for dashboard variance bands or sanity checks on a numeric column:

```ts
import { avg, stddev, stddevPop, typedCol, variance } from "sumak"

db.selectFrom("requests")
  .select("region")
  .select({
    p50: avg(typedCol<number>("latency_ms")),
    jitter: stddev(typedCol<number>("latency_ms")),
    spreadPop: stddevPop(typedCol<number>("latency_ms")),
    spreadSq: variance(typedCol<number>("latency_ms")),
  })
  .groupBy("region")
  .toSQL()

// SELECT "region",
//   AVG("latency_ms") AS "p50",
//   STDDEV("latency_ms") AS "jitter",
//   STDDEV_POP("latency_ms") AS "spreadPop",
//   VARIANCE("latency_ms") AS "spreadSq"
// FROM "requests" GROUP BY "region"
```

Bivariate / linear-regression aggregates (`corr`, `covarPop`, `covarSamp`, `regrSlope`, `regrIntercept`, `regrR2`) are SQL standard but only **PG** implements them natively. MSSQL, MySQL, and SQLite have no built-in equivalents (hand-rolling with `SUM`/`AVG` and the variance/covariance identities is the workaround); the printer refuses on all three with `UnsupportedDialectFeatureError`.

Use them for quick correlation matrices, ad-spend ROI slopes, or ANOVA-style feature ranking without round-tripping through application code:

```ts
import { corr, covarPop, regrR2, regrSlope, typedCol } from "sumak"

const ctr = typedCol<number>("ctr")
const spend = typedCol<number>("spend")

db.selectFrom("ads")
  .select("campaign")
  .select({
    r: corr(ctr, spend),
    slope: regrSlope(ctr, spend),
    r2: regrR2(ctr, spend),
    cov: covarPop(ctr, spend),
  })
  .groupBy("campaign")
  .toSQL()

// SELECT "campaign",
//   CORR("ctr", "spend") AS "r",
//   REGR_SLOPE("ctr", "spend") AS "slope",
//   REGR_R2("ctr", "spend") AS "r2",
//   COVAR_POP("ctr", "spend") AS "cov"
// FROM "ads" GROUP BY "campaign"
```

Argument order is `(y, x)` — the dependent variable first, per the SQL standard. Swapping has no effect on the magnitude of `corr`, but it flips the meaning of `regrSlope` / `regrIntercept` (now you're regressing x on y instead of y on x). Keep the convention straight or your dashboards will lie.

For ML feature engineering, combine `corr` with `coalesce(..., val(0))` to convert an empty-set NULL into a numeric default the downstream pipeline can pivot on:

```ts
import { coalesce, corr, val } from "sumak"

db.selectFrom("features").select({ corrSafe: coalesce(corr(typedCol("y"), typedCol("x")), val(0)) })
```

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

## PostgreSQL EXCLUDE constraints

`EXCLUDE` is a table-level constraint that generalises `UNIQUE`: instead of equality between rows, you specify any commutative SQL operator. The flagship case is **range-overlap exclusion** — a booking system that needs to guarantee no two reservations for the same room can overlap in time. Without the constraint, the same invariant has to be enforced in application code with all the race conditions that come with it.

Declare on the table:

```ts
const bookings = defineTable(
  "bookings",
  {
    id: serial().primaryKey(),
    room: text().notNull(),
    during: new ColumnBuilder<string>("tstzrange").notNull(),
  },
  {
    constraints: {
      excludes: [
        {
          name: "no_overlap",
          method: "gist",
          elements: [
            { expr: "room", operator: "=" },
            { expr: "during", operator: "&&" },
          ],
        },
      ],
    },
  },
)
```

Emitted SQL (PG):

```sql
CREATE TABLE "bookings" (
  "id" SERIAL PRIMARY KEY,
  "room" text NOT NULL,
  "during" tstzrange NOT NULL,
  CONSTRAINT "no_overlap" EXCLUDE USING gist ("room" WITH =, "during" WITH &&)
)
```

Reads as "no two rows may share a `room` AND have overlapping `during`." The `&&` is PG's range-overlap operator. The composite form `(room WITH =, during WITH &&)` requires the `btree_gist` extension (most managed PG providers ship it; install with `CREATE EXTENSION btree_gist`); a single-element exclude on a range column works on stock PG out of the box.

For a partial exclude — "at most one row per priority among active rows" — add a `where` predicate:

```ts
constraints: {
  excludes: [
    {
      name: "one_active_per_priority",
      elements: [{ expr: "priority", operator: "=" }],
      where: "active = true",
    },
  ],
}
```

The constraint's identity covers the method, the elements, and the `where` predicate. Change any one of them and the migration diff emits a drop + add — there is no in-place `ALTER` for an `EXCLUDE` constraint. The `where` predicate accepts raw SQL (schema-author controlled — never user input) or any `Expression<boolean>`, mirroring the partial-index API.

The operator token is spliced verbatim into the emitted DDL, so sumak runs it through a whitelist (1-4 ASCII punctuation characters from PG's operator alphabet — `+ - * / < > = ~ ! @ # % ^ & | ? ` plus backtick). Anything outside that set raises a `SecurityError` at print time; in practice every common operator (`=`, `<>`, `&&`, `@>`, `<@`, `->>`, etc.) is on the allow-list. The method name goes through `validateFunctionName` (same identifier check as `CREATE INDEX … USING <method>`).

**Dialect support.** PostgreSQL only. MySQL, SQLite, and MSSQL have no equivalent table-constraint grammar — the closest fit on those dialects is a unique partial index, but that only supports equality and so doesn't cover the range-overlap case at all. `compileDDL` throws `UnsupportedDialectFeatureError` (`EXCLUDE_CONSTRAINTS` feature flag) on every non-PG dialect rather than emit SQL the engine will reject.

---

## Schema comments

Schema-level prose lives in the database, not just the code. PostgreSQL and MySQL both expose comments on tables and columns; sumak surfaces both via the schema DSL and threads the value through `diffSchemas` so a comment edit shows up as a normal additive migration step.

Declare on the column or table:

```ts
const users = defineTable(
  "users",
  {
    id: serial().primaryKey(),
    email: text().notNull().comment("Primary contact; case-folded on insert"),
    deletedAt: timestamp().nullable().comment("NULL = live; set by softDelete plugin"),
  },
  {
    comment: "User accounts (renamed from old_users in v1.2)",
  },
)
```

Emitted SQL (PG — two statements per object):

```sql
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "email" text NOT NULL,
  "deletedAt" timestamp
);
COMMENT ON TABLE "users" IS 'User accounts (renamed from old_users in v1.2)';
COMMENT ON COLUMN "users"."email" IS 'Primary contact; case-folded on insert';
COMMENT ON COLUMN "users"."deletedAt" IS 'NULL = live; set by softDelete plugin';
```

MySQL inlines the column comment and uses `ALTER TABLE` for the table-level form:

```sql
CREATE TABLE `users` (
  `id` integer PRIMARY KEY AUTO_INCREMENT,
  `email` text NOT NULL COMMENT 'Primary contact; case-folded on insert',
  `deletedAt` timestamp COMMENT 'NULL = live; set by softDelete plugin'
);
ALTER TABLE `users` COMMENT = 'User accounts (renamed from old_users in v1.2)';
```

Editing a comment after the table already exists is metadata-only — the diff never trips the destructive-gate. Passing a `null` comment to `diffSchemas`' machinery (via dropping the `.comment(...)` call on the column) emits `COMMENT ON … IS NULL` on PG and `ALTER TABLE … COMMENT = ''` on MySQL.

Single quotes in the comment text are escaped automatically (doubled `''`), so `text().comment("Alice's note")` prints `COMMENT 'Alice''s note'` on every supported dialect.

**Dialect support.** PG and MySQL only. SQLite has no portable equivalent — its grammar accepts the keyword in some dialects but treats it as a no-op comment in the DDL text, which is silent-loss territory. MSSQL exposes object metadata via the separate `sp_addextendedproperty` stored procedure, which is a completely different surface; sumak refuses to bridge it under the `COMMENT ON` builder. Compile a `CommentNode` against SQLite or MSSQL and `compileDDL` throws `UnsupportedDialectFeatureError` (`OBJECT_COMMENTS` feature flag). MySQL also refuses the standalone _column_-comment form because the underlying `ALTER TABLE … MODIFY COLUMN` requires the column's full type at modification time — use the inline `.comment("…")` on the column when defining the table instead.

---

## Views (CREATE VIEW / DROP VIEW / MATERIALIZED)

Views are stored named queries — `SELECT … FROM v` evaluates the saved query and projects the result. sumak surfaces the standard `CREATE VIEW`, `DROP VIEW`, and (on PostgreSQL) `MATERIALIZED VIEW` + `REFRESH` forms via the schema-builder DSL, with full dialect-aware rewriting. The embedded SELECT body runs through the same `compile()` pipeline as a top-level query, so any registered plugins (multi-tenant scoping, soft-delete filtering, CASL authz, …) apply automatically — `CREATE VIEW tenant_orders AS SELECT * FROM orders` will not silently leak rows across tenants.

```ts
const sel = db
  .selectFrom("orders")
  .where(({ status }) => status.eq("paid"))
  .select("id", "userId", "total")
  .build()

const ddl = db.compileDDL(db.schema.createView("paid_orders").asSelect(sel).build())
// PG / SQLite : CREATE VIEW "paid_orders" AS SELECT ...
// MySQL       : CREATE VIEW `paid_orders` AS SELECT ...
// MSSQL       : CREATE VIEW [paid_orders] AS SELECT ...
```

### Replacing a view

PostgreSQL and MySQL both accept `CREATE OR REPLACE VIEW`. SQL Server has no `OR REPLACE` keyword but ships an analogous `CREATE OR ALTER VIEW` (since 2016 SP1). SQLite has neither — you must `DROP VIEW IF EXISTS` first. sumak exposes the two spellings as separate builder methods because they're not interchangeable and a single `.orReplace()` that quietly swapped to `CREATE OR ALTER` on MSSQL would obscure dialect-portability mistakes.

```ts
// PG / MySQL
db.schema.createView("v").orReplace().asSelect(sel).build()
// → CREATE OR REPLACE VIEW "v" AS …

// MSSQL only
db.schema.createView("v").orAlter().asSelect(sel).build()
// → CREATE OR ALTER VIEW [v] AS …
```

Calling `.orReplace()` on MSSQL throws `UnsupportedDialectFeatureError` with a pointer at `.orAlter()`. Calling `.orAlter()` on PG/MySQL/SQLite throws likewise. Setting both at once also throws — they're mutually exclusive. `IF NOT EXISTS` and either of the replace flags are mutually exclusive too: `OR REPLACE` / `OR ALTER` overwrite, `IF NOT EXISTS` leaves the existing view, so combining them makes no sense.

For SQLite the idiomatic replace flow is two statements:

```ts
db.compileDDL(db.schema.dropView("v").ifExists().build())
db.compileDDL(db.schema.createView("v").asSelect(sel).build())
```

### Materialized views (PostgreSQL only)

A materialized view caches its query result on disk and stays stale until explicitly refreshed. PostgreSQL is the only one of the four dialects with a first-class `MATERIALIZED VIEW` grammar (Oracle has it too, but isn't in sumak's matrix); MySQL, SQLite, and MSSQL have no equivalent — sumak throws `UnsupportedDialectFeatureError` on those dialects rather than silently emit a plain `VIEW` that would re-execute the query on every read.

```ts
// Populate at creation (default).
db.compileDDL(db.schema.createView("daily_sales").materialized().asSelect(sel).build())
// → CREATE MATERIALIZED VIEW "daily_sales" AS SELECT …

// Create empty — the view is unqueryable until the first REFRESH.
db.compileDDL(
  db.schema.createView("daily_sales").materialized().withData(false).asSelect(sel).build(),
)
// → CREATE MATERIALIZED VIEW "daily_sales" AS SELECT … WITH NO DATA
```

Refresh with `db.schema.refreshMaterializedView(...)`:

```ts
// Locks the view exclusively while the query runs.
db.compileDDL(db.schema.refreshMaterializedView("daily_sales").build())
// → REFRESH MATERIALIZED VIEW "daily_sales"

// Swap-on-finish; readers see old data until done. Requires a
// UNIQUE index on the view's projected rows — PG raises at refresh
// time if that's missing.
db.compileDDL(db.schema.refreshMaterializedView("daily_sales").concurrently().build())
// → REFRESH MATERIALIZED VIEW CONCURRENTLY "daily_sales"
```

Drop with `.materialized()` on the drop builder, otherwise PG rejects the statement (a materialized view and a regular view live in the same namespace but require different `DROP` keywords):

```ts
db.compileDDL(db.schema.dropView("daily_sales").materialized().ifExists().build())
// → DROP MATERIALIZED VIEW IF EXISTS "daily_sales"
```

### Param-bound view bodies

The SELECT embedded in `CREATE VIEW` is rendered by the dialect's full SELECT pipeline, so any `where(({ col }) => col.eq(value))` placeholders bind exactly the way they would in a top-level query — the bound values land in the outer `compileDDL` result's `params`. PostgreSQL accepts bound parameters in view bodies (the value is captured at creation time), but most production deployments use a literal in the view definition instead. If you need a literal, pass it through `val(...)`-then-`unsafeRawExpr` or write the constant directly in the SELECT — sumak doesn't second-guess whether your bound value should be inlined.

### Feature matrix

| Feature                     | PG  | MySQL | SQLite | MSSQL |
| --------------------------- | --- | ----- | ------ | ----- |
| `CREATE VIEW`               | yes | yes   | yes    | yes   |
| `CREATE OR REPLACE VIEW`    | yes | yes   | —      | —     |
| `CREATE OR ALTER VIEW`      | —   | —     | —      | yes   |
| `CREATE VIEW IF NOT EXISTS` | yes | yes   | yes    | —     |
| `TEMPORARY VIEW`            | yes | yes   | yes    | —     |
| `CREATE MATERIALIZED VIEW`  | yes | —     | —      | —     |
| `WITH NO DATA`              | yes | —     | —      | —     |
| `REFRESH MATERIALIZED VIEW` | yes | —     | —      | —     |
| `REFRESH … CONCURRENTLY`    | yes | —     | —      | —     |
| `DROP VIEW IF EXISTS`       | yes | yes   | yes    | —     |
| `DROP VIEW … CASCADE`       | yes | —     | —      | —     |
| `DROP MATERIALIZED VIEW`    | yes | —     | —      | —     |

---

## Sequences (CREATE SEQUENCE / nextval / currval / setval)

Sequences are free-standing monotonic integer sources — useful for advisory IDs, batch numbers, or any counter that needs to outlive a particular table's lifecycle. `AUTO_INCREMENT` / `IDENTITY` columns are scoped to their owning table; sequences are not. PostgreSQL and SQL Server are the two dialects with a first-class `CREATE SEQUENCE` grammar; MySQL and SQLite have no sequence object at all (they only support inline `AUTO_INCREMENT` / `AUTOINCREMENT` on a column). sumak refuses both `CREATE SEQUENCE` and the runtime helpers on the unsupported dialects via the `SEQUENCES` / `SEQUENCE_FNS` feature flags.

```ts
db.compileDDL(
  db.schema
    .createSequence("order_no")
    .dataType("bigint")
    .start(1000)
    .increment(1)
    .cache(50)
    .noCycle()
    .build(),
)
// PG / MSSQL:
//   CREATE SEQUENCE "order_no" AS bigint INCREMENT BY 1 START WITH 1000 CACHE 50 NO CYCLE
```

`.minValue(n)` / `.noMinValue()` / `.maxValue(n)` / `.noMaxValue()` set the bounds; the default is the data type's natural minimum / maximum. `.cycle()` / `.noCycle()` controls wrap-on-overflow behaviour. `.ownedBy("table", "column")` is PG-only — it ties the sequence's lifetime to a column so dropping the column drops the sequence; `.ownedByNone()` clears any existing link. MSSQL has no equivalent and the printer refuses if either ownership method is called on that dialect. `.ifNotExists()` is PG-only on this statement; MSSQL has no first-class form and the printer points at the `IF NOT EXISTS(SELECT * FROM sys.sequences …)` wrapper pattern.

```ts
db.compileDDL(db.schema.dropSequence("order_no").ifExists().build())
// PG / MSSQL: DROP SEQUENCE IF EXISTS "order_no"

db.compileDDL(db.schema.dropSequence("order_no").ifExists().cascade().build())
// PG only: DROP SEQUENCE IF EXISTS "order_no" CASCADE
```

### Runtime access — `nextval` / `currval` / `setval`

On PostgreSQL the three function-shape sequence accessors are the standard idiom. `nextval('seq')` advances the sequence and returns the new value; `currval('seq')` returns the most recent value handed out _in the current session_; `setval('seq', n[, is_called])` sets the sequence's current value (the optional third arg controls whether the next `nextval` returns `n + increment` or `n`).

```ts
import { nextval, currval, setval } from "sumak"

// Build an INSERT that pulls a fresh ID from the sequence.
db.insertInto("orders")
  .values({ order_no: nextval("order_no_seq"), customer_id: 42 })
  .exec()

// Read the value that the most recent INSERT assigned.
const last = await db.executeCompiled(
  db
    .selectFromValues({
      alias: "v",
      columns: ["seq_no"],
      rows: [[currval("order_no_seq")]],
    })
    .selectAll()
    .build(),
)

// Reset the sequence so the next nextval returns 1001.
await db.executeCompiledNoRows(
  db.compile(
    db
      .selectFromValues({
        alias: "v",
        columns: ["v"],
        rows: [[setval("order_no_seq", 1000, true)]],
      })
      .selectAll()
      .build(),
  ),
)
```

The runtime functions are PG-only — calling them on MySQL / SQLite / MSSQL throws `UnsupportedDialectFeatureError` at print time. MSSQL has the equivalent `NEXT VALUE FOR <seq>` grammar but it's not a function call (it's a sequence-value expression), so supporting it cleanly needs a dedicated AST node; that's a future cut. For SQL Server today, fall back to `unsafeRawExpr("NEXT VALUE FOR " + quotedSeqName)` when the sequence name is trusted.

The sequence name passed to `nextval` / `currval` / `setval` is captured as a SQL string literal (not bound) in the emitted SQL — `nextval('order_no_seq')`, not `nextval($1)`. The builder rejects names that don't match a bare SQL identifier (optionally with a `schema.name` prefix) to keep injection out of the literal slot; if your sequence name is genuinely exotic, reach for `unsafeRawExpr` and emit the call directly.

### Feature matrix

| Feature                         | PG  | MySQL | SQLite | MSSQL |
| ------------------------------- | --- | ----- | ------ | ----- |
| `CREATE SEQUENCE`               | yes | —     | —      | yes   |
| `CREATE SEQUENCE … AS …`        | yes | —     | —      | yes   |
| `INCREMENT / START / …`         | yes | —     | —      | yes   |
| `OWNED BY …`                    | yes | —     | —      | —     |
| `CREATE SEQUENCE IF NOT EXISTS` | yes | —     | —      | —     |
| `DROP SEQUENCE`                 | yes | —     | —      | yes   |
| `DROP SEQUENCE IF EXISTS`       | yes | —     | —      | yes   |
| `DROP SEQUENCE … CASCADE`       | yes | —     | —      | —     |
| `nextval / currval / setval`    | yes | —     | —      | —     |

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

### Date arithmetic — `dateAdd` / `dateSub`

```ts
import { dateAdd, dateSub, typedCol } from "sumak"

// dateAdd(expr, amount, unit) — every dialect emits its native shape
db.selectFrom("events")
  .select({
    expires: dateAdd(typedCol<Date>("created_at"), 7, "day"),
    expiresMinus: dateSub(typedCol<Date>("created_at"), 1, "month"),
  })
  .toSQL()

// PG:     SELECT ("created_at" + INTERVAL '7 days') AS "expires",
//                ("created_at" - INTERVAL '1 months') AS "expiresMinus"
// MySQL:  SELECT DATE_ADD(`created_at`, INTERVAL 7 DAY) AS `expires`,
//                DATE_SUB(`created_at`, INTERVAL 1 MONTH) AS `expiresMinus`
// MSSQL:  SELECT DATEADD(day, 7, [created_at]) AS [expires],
//                DATEADD(month, -1, [created_at]) AS [expiresMinus]
// SQLite: SELECT datetime("created_at", '+7 days') AS "expires",
//                datetime("created_at", '-1 months') AS "expiresMinus"
```

Both builders accept the closed unit enum `"year" | "month" | "week" | "day" | "hour" | "minute" | "second"`. The `amount` argument is captured as a SQL literal (validated as a finite integer at build time); the engines treat it as part of the plan-cache key, so parameterising it would degrade plan reuse. Pass a negative `amount` to `dateAdd` to subtract, or use `dateSub` for explicit subtraction — both compile through the same AST node, just with the sign normalised.

The four dialects diverge on the underlying time-zone / type semantics — e.g. SQLite's `datetime()` returns a TEXT in ISO-8601, while PG's `+ INTERVAL` preserves the source type (`timestamp` stays `timestamp`, `timestamptz` stays `timestamptz`). Cast explicitly if you need a different result type.

---

## String manipulation

```ts
import { ltrim, overlay, position, replace, reverse, rtrim, typedCol, val } from "sumak"

const body = typedCol<string>("body")
const email = typedCol<string>("email")
const phone = typedCol<string>("phone")
const title = typedCol<string>("title")

// replace(haystack, needle, replacement) — non-regex substring replace.
// All four dialects, same shape. For pattern replace use regexpReplace.
db.selectFrom("posts")
  .select({ cleaned: replace(body, val("\r\n"), val("\n")) })
  .toSQL()
// PG/MySQL/SQLite/MSSQL: SELECT REPLACE("body", '\r\n', '\n') AS "cleaned" FROM "posts"

// position(needle, haystack) — 1-based index of needle in haystack, or 0.
// PG / MySQL / SQLite emit the standard POSITION(needle IN haystack)
// form natively; MSSQL has no POSITION grammar, the printer translates
// to CHARINDEX(needle, haystack) with the same 1-based-or-0 semantics.
// Note the argument order: needle first, like the SQL standard
// (POSITION('@' IN email)) — opposite of JS String.prototype.indexOf.
db.selectFrom("posts")
  .select({ at: position(val("@"), email) })
  .toSQL()
// PG / MySQL / SQLite: SELECT POSITION('@' IN "email") AS "at" FROM "posts"
// MSSQL:               SELECT CHARINDEX('@', [email]) AS [at] FROM [posts]

// overlay(target, replacement, from [, count]) — replace `count` chars
// of `target` starting at 1-based position `from`. SQL standard form.
// PG / MySQL 8 / MSSQL 2017+ accept it natively. SQLite throws — the
// idiom there is SUBSTR + concatenation.
db.selectFrom("posts")
  .select({ masked: overlay(phone, val("***"), 4, 3) })
  .toSQL()
// PG / MySQL 8 / MSSQL: SELECT OVERLAY("phone" PLACING '***' FROM 4 FOR 3) AS "masked" FROM "posts"

// ltrim / rtrim — strip leading / trailing characters. With no second
// argument, strips whitespace. With a `chars` argument, strips any
// character that appears in the set (not prefix-matching).
db.selectFrom("posts")
  .select({
    name: ltrim(rtrim(title)), // strip whitespace both sides
    digits: ltrim(title, val("0")), // strip leading zeros
  })
  .toSQL()
// SELECT LTRIM(RTRIM("title")) AS "name", LTRIM("title", '0') AS "digits" FROM "posts"

// reverse(expr) — character order flip. Built in on PG / MySQL /
// SQLite 3+ / MSSQL.
db.selectFrom("posts")
  .select({ flipped: reverse(title) })
  .toSQL()
// SELECT REVERSE("title") AS "flipped" FROM "posts"
```

Dialect support, at a glance:

| Builder    | PG  | MySQL                | SQLite | MSSQL              |
| ---------- | --- | -------------------- | ------ | ------------------ |
| `replace`  | yes | yes                  | yes    | yes                |
| `position` | yes | yes                  | yes    | yes (→ CHARINDEX)  |
| `overlay`  | yes | 8.0.4+               | no     | 2017+              |
| `ltrim`    | yes | yes (2-arg: 8.0.28+) | yes    | yes (2-arg: 2022+) |
| `rtrim`    | yes | yes (2-arg: 8.0.28+) | yes    | yes (2-arg: 2022+) |
| `reverse`  | yes | yes                  | 3.0+   | yes                |

Where a builder is unsupported, the printer throws `UnsupportedDialectFeatureError` at compile time rather than emit SQL the engine would reject — the failure points at the builder call, not at a generic "no such function" from the driver.

`val()` produces an inline SQL literal (same convention as the regex builders) — the `needle` / `replacement` / `chars` arguments are typically constants, and inlining keeps the statement-cache key stable when only the haystack column varies row-to-row. Use `unsafeRawExpr` or pass a column expression if you genuinely need a runtime-parameterised needle.

---

## Regex matching and extraction

```ts
import { regexpLike, regexpMatches, regexpReplace, regexpSubstr, typedCol } from "sumak"

const body = typedCol<string>("body")
const email = typedCol<string>("email")

// regexpReplace(haystack, pattern, replacement [, flags])
// PG / MySQL 8 / SQLite (with the regexp extension). MSSQL throws.
db.selectFrom("posts")
  .select({ digits: regexpReplace(body, "[^0-9]", "", "g") })
  .toSQL()
// PG/MySQL/SQLite: SELECT REGEXP_REPLACE("body", '[^0-9]', '', 'g') AS "digits"
//                  FROM "posts"

// regexpLike(haystack, pattern [, flags]) — boolean test
// PG 15+ / MySQL 8. SQLite + MSSQL throw.
db.selectFrom("posts")
  .selectAll()
  .where(() => regexpLike(email, "^[^@ ]+@[^@ ]+[.][^@ ]+$"))
  .toSQL()
// PG/MySQL: SELECT * FROM "posts"
//           WHERE REGEXP_LIKE("email", '^[^@ ]+@[^@ ]+[.][^@ ]+$')

// regexpMatches(haystack, pattern [, flags]) — returns text[]
// PG-only. With the 'g' flag, the function is set-returning (yields
// one row per match). MySQL / SQLite / MSSQL throw.
db.selectFrom("posts")
  .select({ urls: regexpMatches(body, "https?://([^ ]+)", "g") })
  .toSQL()
// PG: SELECT REGEXP_MATCHES("body", 'https?://([^ ]+)', 'g') AS "urls"
//     FROM "posts"

// regexpSubstr(haystack, pattern [, position [, occurrence [, flags]]])
// — return the first (or Nth) match. PG 15+ / MySQL 8. SQLite + MSSQL throw.
db.selectFrom("posts")
  .select({ first: regexpSubstr(body, "[[:digit:]]+") })
  .toSQL()
// PG/MySQL: SELECT REGEXP_SUBSTR("body", '[[:digit:]]+') AS "first" FROM "posts"
```

Pattern, replacement, and flags arguments are emitted as **inline SQL string literals** (via the same `escapeStringLiteral` policy as everywhere else in sumak). That keeps the statement-cache key stable when only the haystack column varies, and avoids over-parameterising what is usually a hard-coded regex. Reach for `unsafeRawExpr` if you genuinely need a runtime-parameterised pattern (e.g. user-supplied search).

**Backslash escaping caveat.** sumak doubles backslashes inside string literals as a defence against the MySQL `BACKSLASH_ESCAPES` sql_mode (a known cross-dialect SQL-injection vector). The side-effect is that PCRE-style escapes like `\d`, `\s`, `\w` arrive at the regex engine as literal backslash-then-letter, not as digit/space/word classes. For portable patterns, use:

- POSIX character classes: `[[:digit:]]`, `[[:space:]]`, `[[:alpha:]]`, `[[:alnum:]]`
- Bare character ranges: `[0-9]`, `[a-zA-Z]`
- Bracket negation: `[^@ ]` instead of `[^@\s]`

If you need `\d` etc., write the pattern via `unsafeRawExpr` (and accept that the escape policy then becomes your responsibility).

Dialect support, at a glance:

| Builder         | PG  | MySQL 8 | SQLite               | MSSQL |
| --------------- | --- | ------- | -------------------- | ----- |
| `regexpReplace` | yes | yes     | yes (regexp ext)     | no    |
| `regexpLike`    | 15+ | yes     | no (use `REGEXP` op) | no    |
| `regexpMatches` | yes | no      | no                   | no    |
| `regexpSubstr`  | 15+ | yes     | no                   | no    |

The printer throws `UnsupportedDialectFeatureError` rather than emitting SQL the engine would reject at parse / execution time — so the failure points at the builder call, not at a generic driver error from a missing function.

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
