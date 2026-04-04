import { describe, expect, it, vi } from "vitest";
import { sumak } from "../../src/sumak.ts";
import { pgDialect } from "../../src/dialect/pg.ts";
import { serial, text } from "../../src/schema/column.ts";
import { isNull, col, and } from "../../src/ast/expression.ts";

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: { id: serial(), name: text().notNull() },
    posts: { id: serial(), title: text().notNull() },
  },
});

describe("Hook system", () => {
  it("hook returns unregister function", () => {
    const handler = vi.fn();
    const off = db.hook("query:before", handler);

    const node = db.selectFrom("users").build();
    db.compile(node);
    expect(handler).toHaveBeenCalledOnce();

    off(); // unregister
    db.compile(node);
    expect(handler).toHaveBeenCalledOnce(); // not called again
  });

  it("select:before hook can modify AST", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial(), name: text().notNull() } },
    });

    db2.hook("select:before", (ctx) => {
      // Add WHERE "name" IS NULL
      const condition = isNull(col("name"));
      return {
        ...ctx.node,
        where: ctx.node.where ? and(ctx.node.where, condition) : condition,
      };
    });

    const node = db2.selectFrom("users").build();
    const result = db2.compile(node);
    expect(result.sql).toContain("IS NULL");
    expect(result.sql).toContain('"name"');
  });

  it("query:after hook can modify compiled SQL", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial() } },
    });

    db2.hook("query:after", (ctx) => {
      return { ...ctx.query, sql: ctx.query.sql + " /* traced */" };
    });

    const node = db2.selectFrom("users").build();
    const result = db2.compile(node);
    expect(result.sql).toContain("/* traced */");
  });

  it("result:transform hook converts rows", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial() } },
    });

    db2.hook("result:transform", (rows) => {
      return rows.map((r) => ({ ...r, _processed: true }));
    });

    const result = db2.transformResult([{ id: 1 }, { id: 2 }]);
    expect(result[0]).toEqual({ id: 1, _processed: true });
    expect(result[1]).toEqual({ id: 2, _processed: true });
  });

  it("multiple hooks execute in order", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial() } },
    });

    const order: string[] = [];
    db2.hook("query:before", () => {
      order.push("first");
    });
    db2.hook("query:before", () => {
      order.push("second");
    });

    db2.compile(db2.selectFrom("users").build());
    expect(order).toEqual(["first", "second"]);
  });

  it("hook receives table name in context", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial() } },
    });

    let receivedTable: string | undefined;
    db2.hook("select:before", (ctx) => {
      receivedTable = ctx.table;
    });

    db2.compile(db2.selectFrom("users").build());
    expect(receivedTable).toBe("users");
  });

  it("insert:before hook fires for INSERT", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial(), name: text().notNull() } },
    });

    const handler = vi.fn();
    db2.hook("insert:before", handler);

    const node = db2.insertInto("users").values({ name: "Alice" }).build();
    db2.compile(node);
    expect(handler).toHaveBeenCalledOnce();
  });
});
