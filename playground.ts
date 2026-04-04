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
  typedCol,
  typedEq,
  typedGt,
  typedLit,
  typedParam,
  typedAnd,
  typedIsNull,
  typedLike,
  typedIn,
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
      active: boolean().defaultTo(true),
      metadata: jsonb<{ role: string; level: number }>(),
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
console.log("  lale playground");
console.log("═══════════════════════════════════════\n");

// ─────────────────────────────────────────────
// 2. SELECT
// ─────────────────────────────────────────────

console.log("── SELECT ──\n");

// Basit select
const q1 = db.selectFrom("users").select("id", "name", "email");
console.log(q1.compile(p).sql);
// SELECT "id", "name", "email" FROM "users"

// WHERE ile
const q2 = db
  .selectFrom("users")
  .select("id", "name")
  .where(typedEq(typedCol<number>("id"), typedParam(0, 42)));
const r2 = q2.compile(p);
console.log(r2.sql, "  params:", r2.params);
// SELECT "id", "name" FROM "users" WHERE ("id" = $1)  params: [42]

// Karmaşık WHERE
const q3 = db
  .selectFrom("users")
  .select("id", "name", "email")
  .where(
    typedAnd(
      typedEq(typedCol<boolean>("active"), typedLit(true)),
      typedLike(typedCol<string>("name"), typedLit("%ali%")),
    ),
  )
  .orderBy("name", "ASC")
  .limit(10)
  .offset(0);
console.log(q3.compile(p).sql);

// DISTINCT
const q4 = db.selectFrom("users").select("name").distinct();
console.log(q4.compile(p).sql);

// JOIN
const q5 = db
  .selectFrom("posts")
  .innerJoin("users", typedEq(typedCol<number>("posts.userId"), typedCol<number>("users.id")));
console.log(q5.compile(p).sql);

// LEFT JOIN
const q6 = db
  .selectFrom("users")
  .leftJoin("posts", typedEq(typedCol<number>("users.id"), typedCol<number>("posts.userId")));
console.log(q6.compile(p).sql);

console.log("\n── INSERT ──\n");

// ─────────────────────────────────────────────
// 3. INSERT
// ─────────────────────────────────────────────

// Basit insert — id, active, createdAt opsiyonel (Generated/default)
const q7 = db.insertInto("users").values({
  name: "Alice",
  email: "alice@example.com",
});
const r7 = q7.compile(p);
console.log(r7.sql, "  params:", r7.params);

// RETURNING
const q8 = db
  .insertInto("users")
  .values({ name: "Bob", email: "bob@test.com", active: false })
  .returningAll();
console.log(q8.compile(p).sql);

// ON CONFLICT
const q9 = db
  .insertInto("users")
  .values({ name: "Charlie", email: "charlie@test.com" })
  .onConflictDoNothing("email");
console.log(q9.compile(p).sql);

// Post insert
const q10 = db.insertInto("posts").values({
  title: "Hello World",
  userId: 1,
});
console.log(q10.compile(p).sql);

console.log("\n── UPDATE ──\n");

// ─────────────────────────────────────────────
// 4. UPDATE
// ─────────────────────────────────────────────

const q11 = db
  .update("users")
  .set({ name: "Alice Updated", active: false })
  .where(typedEq(typedCol<number>("id"), typedParam(2, 1)));
const r11 = q11.compile(p);
console.log(r11.sql, "  params:", r11.params);

// RETURNING
const q12 = db
  .update("posts")
  .set({ published: true })
  .where(typedGt(typedCol<number>("userId"), typedLit(0)))
  .returningAll();
console.log(q12.compile(p).sql);

console.log("\n── DELETE ──\n");

// ─────────────────────────────────────────────
// 5. DELETE
// ─────────────────────────────────────────────

const q13 = db.deleteFrom("comments").where(typedEq(typedCol<number>("postId"), typedParam(0, 99)));
const r13 = q13.compile(p);
console.log(r13.sql, "  params:", r13.params);

// RETURNING
const q14 = db
  .deleteFrom("users")
  .where(typedIsNull(typedCol<boolean | null>("active")))
  .returning("id", "email");
console.log(q14.compile(p).sql);

console.log("\n── DIALECTS ──\n");

// ─────────────────────────────────────────────
// 6. Aynı query, farklı dialect'ler
// ─────────────────────────────────────────────

const mysqlDb = lale({
  dialect: mysqlDialect(),
  tables: { users: { id: serial(), name: text().notNull() } },
});
const sqliteDb = lale({
  dialect: sqliteDialect(),
  tables: { users: { id: serial(), name: text().notNull() } },
});

const sameQuery = (d: typeof db | typeof mysqlDb | typeof sqliteDb) =>
  d
    .selectFrom("users")
    .select("id", "name")
    .where(typedEq(typedCol<number>("id"), typedParam(0, 1)));

console.log("PG:     ", sameQuery(db).compile(p).sql);
console.log("MySQL:  ", sameQuery(mysqlDb).compile(mysqlDb.printer()).sql);
console.log("SQLite: ", sameQuery(sqliteDb).compile(sqliteDb.printer()).sql);

console.log("\n── PLUGINS ──\n");

// ─────────────────────────────────────────────
// 7. Plugin'ler
// ─────────────────────────────────────────────

const dbWithPlugins = lale({
  dialect: pgDialect(),
  plugins: [new WithSchemaPlugin("app"), new SoftDeletePlugin({ tables: ["users", "posts"] })],
  tables: {
    users: { id: serial(), name: text().notNull() },
    posts: { id: serial(), title: text().notNull() },
  },
});

const pluginQuery = dbWithPlugins.selectFrom("users").build();
console.log("WithSchema + SoftDelete:");
console.log(dbWithPlugins.compile(pluginQuery).sql);
// SELECT * FROM "app"."users" WHERE ("deleted_at" IS NULL)

// CamelCase plugin
const camel = new CamelCasePlugin();
const rows = camel.transformResult!([
  { user_name: "Alice", created_at: "2026-01-01", is_active: true },
]);
console.log("\nCamelCase transform:", rows[0]);

console.log("\n── HOOKS ──\n");

// ─────────────────────────────────────────────
// 8. Hook sistemi
// ─────────────────────────────────────────────

const dbHooked = lale({
  dialect: pgDialect(),
  tables: {
    users: { id: serial(), name: text().notNull() },
  },
});

// Query logging hook
dbHooked.hook("query:after", (ctx) => {
  console.log(`[LOG] ${ctx.table}: ${ctx.query.sql}`);
});

// SQL comment ekleme
dbHooked.hook("query:after", (ctx) => {
  return { ...ctx.query, sql: `${ctx.query.sql} /* request_id=abc123 */` };
});

const hookedResult = dbHooked.compile(dbHooked.selectFrom("users").build());
console.log("Final:", hookedResult.sql);

// Unregister
const off = dbHooked.hook("query:before", () => {
  console.log("[TEMP] This fires once");
});
dbHooked.compile(dbHooked.selectFrom("users").build());
off(); // artık çalışmaz
dbHooked.compile(dbHooked.selectFrom("users").build());

console.log("\n── IN / BETWEEN / EXISTS ──\n");

// ─────────────────────────────────────────────
// 9. Gelişmiş expression'lar
// ─────────────────────────────────────────────

const qIn = db
  .selectFrom("users")
  .select("id", "name")
  .where(typedIn(typedCol<number>("id"), [typedLit(1), typedLit(2), typedLit(3)]));
console.log(qIn.compile(p).sql);

console.log("\n═══════════════════════════════════════");
console.log("  281 test | 0 lint error | 6527 LOC");
console.log("═══════════════════════════════════════");
