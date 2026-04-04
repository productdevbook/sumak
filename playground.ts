/* eslint-disable no-console */
import {
  lale,
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
} from "./src/index.ts";

// ─────────────────────────────────────────────
// 1. Schema — tek adımda, tip otomatik infer
// ─────────────────────────────────────────────

const db = lale({
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
});

const p = db.printer();

console.log("═══════════════════════════════════════");
console.log("  lale playground — clean API");
console.log("═══════════════════════════════════════\n");

// ─────────────────────────────────────────────
// 2. SELECT — callback where
// ─────────────────────────────────────────────

console.log("── SELECT ──\n");

// Basit
console.log(db.selectFrom("users").select("id", "name").compile(p).sql);

// Where callback — kolonda tip otomatik
const q1 = db.selectFrom("users").where(({ id }) => id.eq(42));
console.log(q1.compile(p).sql, " params:", q1.compile(p).params);

// And/Or combinatorleri
const q2 = db
  .selectFrom("users")
  .select("id", "name", "email")
  .where(({ age, active }) => and(age.gte(18), active.eq(true)))
  .orderBy("name")
  .limit(10);
console.log(q2.compile(p).sql);

// Like
const q3 = db.selectFrom("users").where(({ name }) => name.like("%ali%"));
console.log(q3.compile(p).sql);

// In list
const q4 = db.selectFrom("users").where(({ id }) => id.in([1, 2, 3]));
console.log(q4.compile(p).sql);

// Between
const q5 = db.selectFrom("users").where(({ age }) => age.between(18, 65));
console.log(q5.compile(p).sql);

// IsNull / IsNotNull
const q6 = db.selectFrom("users").where(({ bio }) => bio.isNull());
console.log(q6.compile(p).sql);

// Or
const q7 = db
  .selectFrom("users")
  .where(({ name, email }) => or(name.like("%test%"), email.like("%test%")));
console.log(q7.compile(p).sql);

// ─────────────────────────────────────────────
// 3. JOIN — table-qualified callback
// ─────────────────────────────────────────────

console.log("\n── JOIN ──\n");

const q8 = db
  .selectFrom("users")
  .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId));
console.log(q8.compile(p).sql);

const q9 = db
  .selectFrom("users")
  .leftJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId));
console.log(q9.compile(p).sql);

// ─────────────────────────────────────────────
// 4. INSERT
// ─────────────────────────────────────────────

console.log("\n── INSERT ──\n");

const q10 = db.insertInto("users").values({ name: "Alice", email: "alice@example.com" });
const r10 = q10.compile(p);
console.log(r10.sql, " params:", r10.params);

const q11 = db.insertInto("posts").values({ title: "Hello World", userId: 1 }).returningAll();
console.log(q11.compile(p).sql);

// ─────────────────────────────────────────────
// 5. UPDATE — callback where
// ─────────────────────────────────────────────

console.log("\n── UPDATE ──\n");

const q12 = db
  .update("users")
  .set({ name: "Bob", active: false })
  .where(({ id }) => id.eq(1));
console.log(q12.compile(p).sql);

// ─────────────────────────────────────────────
// 6. DELETE — callback where
// ─────────────────────────────────────────────

console.log("\n── DELETE ──\n");

const q13 = db.deleteFrom("comments").where(({ postId }) => postId.eq(99));
console.log(q13.compile(p).sql);

// ─────────────────────────────────────────────
// 7. Dialect karşılaştırma
// ─────────────────────────────────────────────

console.log("\n── DIALECTS ──\n");

const mysqlDb = lale({
  dialect: mysqlDialect(),
  tables: { users: { id: serial(), name: text().notNull() } },
});
const sqliteDb = lale({
  dialect: sqliteDialect(),
  tables: { users: { id: serial(), name: text().notNull() } },
});

console.log(
  "PG:    ",
  db
    .selectFrom("users")
    .where(({ id }) => id.eq(1))
    .compile(p).sql,
);
console.log(
  "MySQL: ",
  mysqlDb
    .selectFrom("users")
    .where(({ id }) => id.eq(1))
    .compile(mysqlDb.printer()).sql,
);
console.log(
  "SQLite:",
  sqliteDb
    .selectFrom("users")
    .where(({ id }) => id.eq(1))
    .compile(sqliteDb.printer()).sql,
);

// ─────────────────────────────────────────────
// 8. Plugin'ler
// ─────────────────────────────────────────────

console.log("\n── PLUGINS ──\n");

const dbPlugins = lale({
  dialect: pgDialect(),
  plugins: [new WithSchemaPlugin("app"), new SoftDeletePlugin({ tables: ["users"] })],
  tables: { users: { id: serial(), name: text().notNull() } },
});
console.log(dbPlugins.compile(dbPlugins.selectFrom("users").build()).sql);

const camel = new CamelCasePlugin();
console.log(camel.transformResult!([{ first_name: "Alice", created_at: "2026-01-01" }])[0]);

// ─────────────────────────────────────────────
// 9. Hooks
// ─────────────────────────────────────────────

console.log("\n── HOOKS ──\n");

const dbH = lale({ dialect: pgDialect(), tables: { users: { id: serial() } } });
dbH.hook("query:after", (ctx) => {
  console.log(`[LOG] ${ctx.query.sql}`);
  return { ...ctx.query, sql: `${ctx.query.sql} /* traced */` };
});
console.log("Result:", dbH.compile(dbH.selectFrom("users").build()).sql);

console.log("\n═══════════════════════════════════════");
console.log("  ESKİ API vs YENİ API");
console.log("═══════════════════════════════════════\n");

console.log("ESKİ: typedEq(typedCol<number>('id'), typedParam(0, 42))");
console.log("YENİ: ({ id }) => id.eq(42)");
console.log("\nESKİ: typedAnd(typedGt(typedCol<number>('age'), typedLit(18)), typedEq(...))");
console.log("YENİ: ({ age, active }) => and(age.gte(18), active.eq(true))");
console.log(
  "\nESKİ: innerJoin('posts', typedEq(typedCol<number>('users.id'), typedCol<number>('posts.userId')))",
);
console.log("YENİ: innerJoin('posts', ({ users, posts }) => users.id.eqCol(posts.userId))");
