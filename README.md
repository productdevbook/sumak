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
import { sumak, pgDialect, serial, text, boolean, integer } from "sumak"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      active: boolean().defaultTo(true),
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

```ts
// SELECT
db.selectFrom("users")
  .select("id", "name")
  .where(({ age, active }) => and(age.gte(18), active.eq(true)))
  .orderBy("name")
  .limit(10)
  .compile(db.printer())

// INSERT
db.insertInto("users")
  .values({
    name: "Alice",
    email: "alice@example.com",
  })
  .returningAll()
  .compile(db.printer())

// UPDATE
db.update("users")
  .set({ active: false })
  .where(({ id }) => id.eq(1))
  .compile(db.printer())

// DELETE
db.deleteFrom("users")
  .where(({ id }) => id.eq(1))
  .returning("id")
  .compile(db.printer())
```

## Joins

```ts
db.selectFrom("users")
  .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
  .compile(db.printer())
```

## Tree Shaking

Import only the dialect you need:

```ts
import { sumak } from "sumak"
import { pgDialect } from "sumak/pg"
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
```

## Plugins

```ts
import { WithSchemaPlugin, SoftDeletePlugin, CamelCasePlugin } from "sumak";

const db = sumak({
  dialect: pgDialect(),
  plugins: [
    new WithSchemaPlugin("public"),
    new SoftDeletePlugin({ tables: ["users"] }),
  ],
  tables: { ... },
});

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

## Expression API

```ts
// Equality
.where(({ id }) =>
  id.eq(42),
)

// String matching
.where(({ name }) =>
  name.like("%ali%"),
)

// Range
.where(({ age }) =>
  age.between(18, 65),
)

// List
.where(({ id }) =>
  id.in([1, 2, 3]),
)

// Null checks
.where(({ bio }) =>
  bio.isNull(),
)
.where(({ email }) =>
  email.isNotNull(),
)

// AND
.where(({ a, b }) =>
  and(
    a.gt(0),
    b.neq("x"),
  ),
)

// OR
.where(({ a, b }) =>
  or(
    a.eq(1),
    b.eq(2),
  ),
)
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
- **Printer Layer** — `BasePrinter` with dialect subclasses, Wadler document algebra

## License

[MIT](./LICENSE)
