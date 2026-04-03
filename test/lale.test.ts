import { describe, expect, it } from "vitest";
import { lale } from "../src/lale.ts";
import { pgDialect } from "../src/dialect/pg.ts";
import { boolean, integer, serial, text, timestamp } from "../src/schema/column.ts";
import { typedCol, typedEq, typedParam } from "../src/ast/typed-expression.ts";
import { WithSchemaPlugin } from "../src/plugin/with-schema.ts";
import { SoftDeletePlugin } from "../src/plugin/soft-delete.ts";

// One-step setup — no manual type DB = {...} needed
const db = lale({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      active: boolean().defaultTo(true),
      createdAt: timestamp().defaultTo("now()"),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      body: text().nullable(),
      userId: integer().references("users", "id"),
    },
  },
});

describe("lale() — clean API", () => {
  it("selectFrom infers table names", () => {
    const q = db.selectFrom("users");
    expect(q.compile(db.printer()).sql).toBe('SELECT * FROM "users"');
  });

  it("select narrows columns", () => {
    const q = db.selectFrom("users").select("id", "name");
    expect(q.compile(db.printer()).sql).toBe('SELECT "id", "name" FROM "users"');
  });

  it("where with typed expressions", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(typedEq(typedCol<number>("id"), typedParam(0, 42)));
    const result = q.compile(db.printer());
    expect(result.sql).toContain("WHERE");
    expect(result.params).toEqual([42]);
  });

  it("insertInto with type-safe values", () => {
    const q = db.insertInto("users").values({
      name: "Alice",
      email: "alice@example.com",
    });
    const result = q.compile(db.printer());
    expect(result.sql).toContain("INSERT INTO");
    expect(result.params).toContain("Alice");
  });

  it("insertInto posts", () => {
    const q = db.insertInto("posts").values({
      title: "Hello World",
      userId: 1,
    });
    const result = q.compile(db.printer());
    expect(result.sql).toContain('"posts"');
    expect(result.params).toContain("Hello World");
  });

  it("update with type-safe set", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(typedEq(typedCol<number>("id"), typedParam(1, 1)));
    const result = q.compile(db.printer());
    expect(result.sql).toContain("UPDATE");
    expect(result.sql).toContain("SET");
  });

  it("deleteFrom with where", () => {
    const q = db.deleteFrom("users").where(typedEq(typedCol<number>("id"), typedParam(0, 1)));
    const result = q.compile(db.printer());
    expect(result.sql).toContain("DELETE FROM");
    expect(result.params).toEqual([1]);
  });

  it("compile runs plugin pipeline", () => {
    const dbWithPlugins = lale({
      dialect: pgDialect(),
      plugins: [new WithSchemaPlugin("public")],
      tables: {
        users: { id: serial(), name: text().notNull() },
      },
    });

    const node = dbWithPlugins.selectFrom("users").build();
    const result = dbWithPlugins.compile(node);
    expect(result.sql).toContain('"public"."users"');
  });

  it("compile runs multiple plugins", () => {
    const dbWithPlugins = lale({
      dialect: pgDialect(),
      plugins: [new WithSchemaPlugin("app"), new SoftDeletePlugin({ tables: ["users"] })],
      tables: {
        users: { id: serial(), name: text().notNull() },
      },
    });

    const node = dbWithPlugins.selectFrom("users").build();
    const result = dbWithPlugins.compile(node);
    expect(result.sql).toContain('"app"."users"');
    expect(result.sql).toContain("IS NULL");
  });
});
