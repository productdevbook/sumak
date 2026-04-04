import { describe, expect, it } from "vitest";
import { sumak } from "../../src/sumak.ts";
import { pgDialect } from "../../src/dialect/pg.ts";
import { boolean, serial, text } from "../../src/schema/column.ts";

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      active: boolean().defaultTo(true),
    },
  },
});

const printer = db.printer();

describe("TypedUpdateBuilder", () => {
  it("updates with SET and WHERE callback", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1));
    const result = q.compile(printer);
    expect(result.sql).toContain("UPDATE");
    expect(result.sql).toContain("SET");
    expect(result.sql).toContain("WHERE");
  });

  it("updates multiple columns", () => {
    const q = db.update("users").set({ name: "Bob", active: false });
    const result = q.compile(printer);
    expect(result.sql).toContain('"name"');
    expect(result.sql).toContain('"active"');
  });

  it("updates with RETURNING *", () => {
    const q = db.update("users").set({ name: "Bob" }).returningAll();
    expect(q.compile(printer).sql).toContain("RETURNING *");
  });

  it("updates with RETURNING specific columns", () => {
    const q = db.update("users").set({ name: "Bob" }).returning("id", "name");
    expect(q.compile(printer).sql).toContain("RETURNING");
  });
});
