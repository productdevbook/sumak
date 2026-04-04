/* eslint-disable no-console */
import {
  sumak,
  pgDialect,
  mysqlDialect,
  sqliteDialect,
  serial,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  varchar,
  and,
  or,
  WithSchemaPlugin,
  SoftDeletePlugin,
  CamelCasePlugin,
} from "./src/index.ts"

// ─────────────────────────────────────────────
// 1. Schema
// ─────────────────────────────────────────────

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: varchar(255).notNull(),
      bio: text().nullable(),
      age: integer(),
      active: boolean().defaultTo(true),
      metadata: jsonb<{ role: string }>(),
      createdAt: timestamp().defaultTo("now()"),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      body: text().nullable(),
      published: boolean().defaultTo(false),
      userId: integer().references("users", "id"),
      createdAt: timestamp().defaultTo("now()"),
    },
    comments: {
      id: serial().primaryKey(),
      content: text().notNull(),
      postId: integer().references("posts", "id"),
      userId: integer().references("users", "id"),
    },
  },
})

const p = db.printer()

console.log("═══════════════════════════════════════")
console.log("  sumak playground")
console.log("═══════════════════════════════════════\n")

// ─────────────────────────────────────────────
// 2. SELECT
// ─────────────────────────────────────────────

console.log("── SELECT ──\n")

const q1 = db.selectFrom("users").select("id", "name")

console.log(q1.compile(p).sql)

const q2 = db.selectFrom("users").where(({ id }) => id.eq(42))

const r2 = q2.compile(p)
console.log(r2.sql)
console.log("params:", r2.params)

const q3 = db
  .selectFrom("users")
  .select("id", "name", "email")
  .where(({ age, active }) => and(age.gte(18), active.eq(true)))
  .orderBy("name")
  .limit(10)

console.log(q3.compile(p).sql)

const q4 = db.selectFrom("users").where(({ name }) => name.like("%ali%"))

console.log(q4.compile(p).sql)

const q5 = db.selectFrom("users").where(({ id }) => id.in([1, 2, 3]))

console.log(q5.compile(p).sql)

const q6 = db.selectFrom("users").where(({ age }) => age.between(18, 65))

console.log(q6.compile(p).sql)

const q7 = db.selectFrom("users").where(({ bio }) => bio.isNull())

console.log(q7.compile(p).sql)

const q8 = db
  .selectFrom("users")
  .where(({ name, email }) => or(name.like("%test%"), email.like("%test%")))

console.log(q8.compile(p).sql)

// ─────────────────────────────────────────────
// 3. JOIN
// ─────────────────────────────────────────────

console.log("\n── JOIN ──\n")

const q9 = db
  .selectFrom("users")
  .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))

console.log(q9.compile(p).sql)

const q10 = db
  .selectFrom("users")
  .leftJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))

console.log(q10.compile(p).sql)

// ─────────────────────────────────────────────
// 4. INSERT
// ─────────────────────────────────────────────

console.log("\n── INSERT ──\n")

const q11 = db.insertInto("users").values({
  name: "Alice",
  email: "alice@example.com",
})

const r11 = q11.compile(p)
console.log(r11.sql)
console.log("params:", r11.params)

const q12 = db
  .insertInto("posts")
  .values({
    title: "Hello World",
    userId: 1,
  })
  .returningAll()

console.log(q12.compile(p).sql)

// ─────────────────────────────────────────────
// 5. UPDATE
// ─────────────────────────────────────────────

console.log("\n── UPDATE ──\n")

const q13 = db
  .update("users")
  .set({
    name: "Bob",
    active: false,
  })
  .where(({ id }) => id.eq(1))

console.log(q13.compile(p).sql)

// ─────────────────────────────────────────────
// 6. DELETE
// ─────────────────────────────────────────────

console.log("\n── DELETE ──\n")

const q14 = db.deleteFrom("comments").where(({ postId }) => postId.eq(99))

console.log(q14.compile(p).sql)

// ─────────────────────────────────────────────
// 7. Dialects
// ─────────────────────────────────────────────

console.log("\n── DIALECTS ──\n")

const mysqlDb = sumak({
  dialect: mysqlDialect(),
  tables: {
    users: {
      id: serial(),
      name: text().notNull(),
    },
  },
})

const sqliteDb = sumak({
  dialect: sqliteDialect(),
  tables: {
    users: {
      id: serial(),
      name: text().notNull(),
    },
  },
})

const pgResult = db
  .selectFrom("users")
  .where(({ id }) => id.eq(1))
  .compile(p)

const mysqlResult = mysqlDb
  .selectFrom("users")
  .where(({ id }) => id.eq(1))
  .compile(mysqlDb.printer())

const sqliteResult = sqliteDb
  .selectFrom("users")
  .where(({ id }) => id.eq(1))
  .compile(sqliteDb.printer())

console.log("PG:    ", pgResult.sql)
console.log("MySQL: ", mysqlResult.sql)
console.log("SQLite:", sqliteResult.sql)

// ─────────────────────────────────────────────
// 8. Plugins
// ─────────────────────────────────────────────

console.log("\n── PLUGINS ──\n")

const dbPlugins = sumak({
  dialect: pgDialect(),
  plugins: [new WithSchemaPlugin("app"), new SoftDeletePlugin({ tables: ["users"] })],
  tables: {
    users: {
      id: serial(),
      name: text().notNull(),
    },
  },
})

const pluginNode = dbPlugins.selectFrom("users").build()

console.log(dbPlugins.compile(pluginNode).sql)

const camel = new CamelCasePlugin()
const rows = camel.transformResult!([
  {
    first_name: "Alice",
    created_at: "2026-01-01",
  },
])
console.log(rows[0])

// ─────────────────────────────────────────────
// 9. Hooks
// ─────────────────────────────────────────────

console.log("\n── HOOKS ──\n")

const dbH = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial(),
    },
  },
})

dbH.hook("query:after", (ctx) => {
  console.log(`[LOG] ${ctx.query.sql}`)
  return {
    ...ctx.query,
    sql: `${ctx.query.sql} /* traced */`,
  }
})

const hookNode = dbH.selectFrom("users").build()

const hookResult = dbH.compile(hookNode)
console.log("Result:", hookResult.sql)
