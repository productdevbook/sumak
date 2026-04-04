import { describe, expect, it } from "vitest";
import { sumak } from "../../src/sumak.ts";
import { pgDialect } from "../../src/dialect/pg.ts";
import { serial, text, integer, boolean } from "../../src/schema/column.ts";
import { and, or } from "../../src/builder/eb.ts";

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer(),
      active: boolean().defaultTo(true),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      userId: integer(),
    },
  },
});

const p = db.printer();

describe("Clean callback API", () => {
  describe("where callback", () => {
    it("simple eq", () => {
      const q = db.selectFrom("users").where(({ id }) => id.eq(42));
      const r = q.compile(p);
      expect(r.sql).toBe('SELECT * FROM "users" WHERE ("id" = $1)');
      expect(r.params).toEqual([42]);
    });

    it("string like", () => {
      const q = db.selectFrom("users").where(({ name }) => name.like("%ali%"));
      expect(q.compile(p).sql).toContain("LIKE");
    });

    it("gt comparison", () => {
      const q = db.selectFrom("users").where(({ age }) => age.gt(18));
      const r = q.compile(p);
      expect(r.sql).toContain(">");
      expect(r.params).toEqual([18]);
    });

    it("in list", () => {
      const q = db.selectFrom("users").where(({ id }) => id.in([1, 2, 3]));
      const r = q.compile(p);
      expect(r.sql).toContain("IN");
      expect(r.params).toEqual([1, 2, 3]);
    });

    it("isNull", () => {
      const q = db.selectFrom("users").where(({ age }) => age.isNull());
      expect(q.compile(p).sql).toContain("IS NULL");
    });

    it("isNotNull", () => {
      const q = db.selectFrom("users").where(({ email }) => email.isNotNull());
      expect(q.compile(p).sql).toContain("IS NOT NULL");
    });

    it("between", () => {
      const q = db.selectFrom("users").where(({ age }) => age.between(18, 65));
      const r = q.compile(p);
      expect(r.sql).toContain("BETWEEN");
      expect(r.params).toEqual([18, 65]);
    });

    it("notIn", () => {
      const q = db.selectFrom("users").where(({ id }) => id.notIn([99, 100]));
      expect(q.compile(p).sql).toContain("NOT IN");
    });

    it("and combinator", () => {
      const q = db.selectFrom("users").where(({ age, active }) => and(age.gt(18), active.eq(true)));
      const r = q.compile(p);
      expect(r.sql).toContain("AND");
      expect(r.params).toEqual([18, true]);
    });

    it("or combinator", () => {
      const q = db
        .selectFrom("users")
        .where(({ name, email }) => or(name.like("%alice%"), email.like("%alice%")));
      expect(q.compile(p).sql).toContain("OR");
    });

    it("neq", () => {
      const q = db.selectFrom("users").where(({ active }) => active.neq(false));
      expect(q.compile(p).sql).toContain("!=");
    });

    it("gte / lte", () => {
      const q1 = db.selectFrom("users").where(({ age }) => age.gte(18));
      expect(q1.compile(p).sql).toContain(">=");

      const q2 = db.selectFrom("users").where(({ age }) => age.lte(65));
      expect(q2.compile(p).sql).toContain("<=");
    });
  });

  describe("join callback", () => {
    it("innerJoin with table-qualified columns", () => {
      const q = db
        .selectFrom("users")
        .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId));
      const r = q.compile(p);
      expect(r.sql).toContain("INNER JOIN");
      expect(r.sql).toContain('"users"."id"');
      expect(r.sql).toContain('"posts"."userId"');
    });

    it("leftJoin with callback", () => {
      const q = db
        .selectFrom("users")
        .leftJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId));
      expect(q.compile(p).sql).toContain("LEFT JOIN");
    });
  });

  describe("update where callback", () => {
    it("update with callback where", () => {
      const q = db
        .update("users")
        .set({ name: "Bob" })
        .where(({ id }) => id.eq(1));
      const r = q.compile(p);
      expect(r.sql).toContain("UPDATE");
      expect(r.sql).toContain("WHERE");
    });
  });

  describe("delete where callback", () => {
    it("delete with callback where", () => {
      const q = db.deleteFrom("users").where(({ id }) => id.eq(1));
      const r = q.compile(p);
      expect(r.sql).toContain("DELETE FROM");
      expect(r.sql).toContain("WHERE");
    });
  });

  describe("select + where chain", () => {
    it("full query with callback API", () => {
      const q = db
        .selectFrom("users")
        .select("id", "name", "email")
        .where(({ age, active }) => and(age.gte(18), active.eq(true)))
        .orderBy("name")
        .limit(10);
      const r = q.compile(p);
      expect(r.sql).toContain("SELECT");
      expect(r.sql).toContain("WHERE");
      expect(r.sql).toContain("ORDER BY");
      expect(r.sql).toContain("LIMIT");
      expect(r.params).toEqual([18, true]);
    });
  });
});
