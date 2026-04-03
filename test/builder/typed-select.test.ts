import { describe, expect, it } from "vitest";
import { Lale } from "../../src/lale.ts";
import { pgDialect } from "../../src/dialect/pg.ts";
import { mysqlDialect } from "../../src/dialect/mysql.ts";
import { defineTable } from "../../src/schema/table.ts";
import type { InferTable } from "../../src/schema/table.ts";
import { boolean, serial, text, timestamp } from "../../src/schema/column.ts";
import {
  typedCol,
  typedEq,
  typedGt,
  typedLit,
  typedParam,
} from "../../src/ast/typed-expression.ts";
// Schema
const users = defineTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  active: boolean().defaultTo(true),
  createdAt: timestamp().defaultTo("now()"),
});

const posts = defineTable("posts", {
  id: serial().primaryKey(),
  title: text().notNull(),
  userId: serial(),
});

type DB = {
  users: InferTable<typeof users>;
  posts: InferTable<typeof posts>;
};

const db = new Lale<DB>(pgDialect());
const printer = db.printer();

describe("TypedSelectBuilder", () => {
  it("builds SELECT * FROM table", () => {
    const q = db.selectFrom("users");
    const result = q.compile(printer);
    expect(result.sql).toBe('SELECT * FROM "users"');
  });

  it("builds SELECT with specific columns", () => {
    const q = db.selectFrom("users").select("id", "name");
    const result = q.compile(printer);
    expect(result.sql).toBe('SELECT "id", "name" FROM "users"');
  });

  it("infers correct output type for select", () => {
    const q = db.selectFrom("users").select("id", "name");
    expect(q.compile(printer).sql).toContain('"id"');
  });

  it("builds SELECT DISTINCT", () => {
    const q = db.selectFrom("users").select("name").distinct();
    expect(q.compile(printer).sql).toContain("DISTINCT");
  });

  it("builds SELECT with WHERE", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(typedEq(typedCol<number>("id"), typedParam(0, 42)));
    const result = q.compile(printer);
    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain("$1");
    expect(result.params).toEqual([42]);
  });

  it("builds SELECT with INNER JOIN", () => {
    const q = db
      .selectFrom("users")
      .innerJoin("posts", typedEq(typedCol<number>("users.id"), typedCol<number>("posts.userId")));
    const result = q.compile(printer);
    expect(result.sql).toContain("INNER JOIN");
  });

  it("builds SELECT with LEFT JOIN", () => {
    const q = db
      .selectFrom("users")
      .leftJoin("posts", typedEq(typedCol<number>("users.id"), typedCol<number>("posts.userId")));
    const result = q.compile(printer);
    expect(result.sql).toContain("LEFT JOIN");
  });

  it("builds SELECT with ORDER BY", () => {
    const q = db.selectFrom("users").orderBy("name", "ASC");
    expect(q.compile(printer).sql).toContain("ORDER BY");
  });

  it("builds SELECT with LIMIT and OFFSET", () => {
    const q = db.selectFrom("users").limit(10).offset(20);
    const result = q.compile(printer);
    expect(result.sql).toContain("LIMIT 10");
    expect(result.sql).toContain("OFFSET 20");
  });

  it("builds SELECT with GROUP BY and HAVING", () => {
    const q = db
      .selectFrom("users")
      .groupBy("active")
      .having(typedGt(typedCol<number>("id"), typedLit(5)));
    const result = q.compile(printer);
    expect(result.sql).toContain("GROUP BY");
    expect(result.sql).toContain("HAVING");
  });

  it("builds SELECT FOR UPDATE", () => {
    const q = db.selectFrom("users").forUpdate();
    expect(q.compile(printer).sql).toContain("FOR UPDATE");
  });

  it("works with MySQL dialect", () => {
    const mysqlDb = new Lale<DB>(mysqlDialect());
    const q = mysqlDb.selectFrom("users").select("id");
    const result = q.compile(mysqlDb.printer());
    expect(result.sql).toContain("`id`");
    expect(result.sql).toContain("`users`");
  });

  it("builds UNION query", () => {
    const q1 = db.selectFrom("users").select("id");
    const q2 = db.selectFrom("users").select("id");
    const result = q1.union(q2).compile(printer);
    expect(result.sql).toContain("UNION");
  });
});
