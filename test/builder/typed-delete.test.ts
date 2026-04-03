import { describe, expect, it } from "vitest";
import { Lale } from "../../src/lale.ts";
import { pgDialect } from "../../src/dialect/pg.ts";
import { defineTable } from "../../src/schema/table.ts";
import type { InferTable } from "../../src/schema/table.ts";
import { boolean, serial, text } from "../../src/schema/column.ts";
import { typedCol, typedEq, typedLit, typedParam } from "../../src/ast/typed-expression.ts";

const users = defineTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  active: boolean().defaultTo(true),
});

type DB = { users: InferTable<typeof users> };

const db = new Lale<DB>(pgDialect());
const printer = db.printer();

describe("TypedDeleteBuilder", () => {
  it("deletes with WHERE", () => {
    const q = db.deleteFrom("users").where(typedEq(typedCol<number>("id"), typedParam(0, 1)));
    const result = q.compile(printer);
    expect(result.sql).toContain('DELETE FROM "users"');
    expect(result.sql).toContain("WHERE");
    expect(result.params).toEqual([1]);
  });

  it("deletes with RETURNING *", () => {
    const q = db
      .deleteFrom("users")
      .where(typedEq(typedCol<boolean>("active"), typedLit(false)))
      .returningAll();
    const result = q.compile(printer);
    expect(result.sql).toContain("RETURNING *");
  });

  it("deletes with RETURNING specific columns", () => {
    const q = db
      .deleteFrom("users")
      .where(typedEq(typedCol<number>("id"), typedParam(0, 1)))
      .returning("id");
    const result = q.compile(printer);
    expect(result.sql).toContain("RETURNING");
    expect(result.sql).toContain('"id"');
  });
});
