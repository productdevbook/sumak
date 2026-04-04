import { describe, expect, it } from "vitest";
import { pamuk } from "../../src/pamuk.ts";
import { pgDialect } from "../../src/dialect/pg.ts";
import { mysqlDialect } from "../../src/dialect/mysql.ts";
import { boolean, integer, serial, text, timestamp } from "../../src/schema/column.ts";
import { and } from "../../src/builder/eb.ts";

const db = pamuk({
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
      userId: integer(),
    },
  },
});

const printer = db.printer();

describe("TypedSelectBuilder", () => {
  it("builds SELECT * FROM table", () => {
    const q = db.selectFrom("users");
    expect(q.compile(printer).sql).toBe('SELECT * FROM "users"');
  });

  it("builds SELECT with specific columns", () => {
    const q = db.selectFrom("users").select("id", "name");
    expect(q.compile(printer).sql).toBe('SELECT "id", "name" FROM "users"');
  });

  it("builds SELECT DISTINCT", () => {
    const q = db.selectFrom("users").select("name").distinct();
    expect(q.compile(printer).sql).toContain("DISTINCT");
  });

  it("builds SELECT with WHERE callback", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ id }) => id.eq(42));
    const result = q.compile(printer);
    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain("$1");
    expect(result.params).toEqual([42]);
  });

  it("builds SELECT with INNER JOIN callback", () => {
    const q = db
      .selectFrom("users")
      .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId));
    expect(q.compile(printer).sql).toContain("INNER JOIN");
  });

  it("builds SELECT with LEFT JOIN callback", () => {
    const q = db
      .selectFrom("users")
      .leftJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId));
    expect(q.compile(printer).sql).toContain("LEFT JOIN");
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
      .having(({ id }) => id.gt(5));
    const result = q.compile(printer);
    expect(result.sql).toContain("GROUP BY");
    expect(result.sql).toContain("HAVING");
  });

  it("builds SELECT FOR UPDATE", () => {
    const q = db.selectFrom("users").forUpdate();
    expect(q.compile(printer).sql).toContain("FOR UPDATE");
  });

  it("works with MySQL dialect", () => {
    const mysqlDb = pamuk({
      dialect: mysqlDialect(),
      tables: { users: { id: serial(), name: text().notNull() } },
    });
    const q = mysqlDb.selectFrom("users").select("id");
    const result = q.compile(mysqlDb.printer());
    expect(result.sql).toContain("`id`");
    expect(result.sql).toContain("`users`");
  });

  it("builds UNION query", () => {
    const q1 = db.selectFrom("users").select("id");
    const q2 = db.selectFrom("users").select("id");
    expect(q1.union(q2).compile(printer).sql).toContain("UNION");
  });

  it("composes and/or in where", () => {
    const q = db
      .selectFrom("users")
      .where(({ active, name }) => and(active.eq(true), name.like("%ali%")));
    const result = q.compile(printer);
    expect(result.sql).toContain("AND");
    expect(result.sql).toContain("LIKE");
  });
});
