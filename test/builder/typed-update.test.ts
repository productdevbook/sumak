import { describe, expect, it } from "vitest";
import { Lale } from "../../src/lale.ts";
import { pgDialect } from "../../src/dialect/pg.ts";
import { defineTable } from "../../src/schema/table.ts";
import type { InferTable } from "../../src/schema/table.ts";
import { boolean, serial, text } from "../../src/schema/column.ts";
import { typedCol, typedEq, typedParam } from "../../src/ast/typed-expression.ts";

const users = defineTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  active: boolean().defaultTo(true),
});

type DB = { users: InferTable<typeof users> };

const db = new Lale<DB>({ dialect: pgDialect() });
const printer = db.printer();

describe("TypedUpdateBuilder", () => {
  it("updates with SET and WHERE", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(typedEq(typedCol<number>("id"), typedParam(1, 1)));
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
    const result = q.compile(printer);
    expect(result.sql).toContain("RETURNING *");
  });

  it("updates with RETURNING specific columns", () => {
    const q = db.update("users").set({ name: "Bob" }).returning("id", "name");
    const result = q.compile(printer);
    expect(result.sql).toContain("RETURNING");
  });
});
