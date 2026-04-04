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

describe("TypedDeleteBuilder", () => {
  it("deletes with WHERE callback", () => {
    const q = db.deleteFrom("users").where(({ id }) => id.eq(1));
    const result = q.compile(printer);
    expect(result.sql).toContain('DELETE FROM "users"');
    expect(result.sql).toContain("WHERE");
    expect(result.params).toEqual([1]);
  });

  it("deletes with RETURNING *", () => {
    const q = db
      .deleteFrom("users")
      .where(({ active }) => active.eq(false))
      .returningAll();
    expect(q.compile(printer).sql).toContain("RETURNING *");
  });

  it("deletes with RETURNING specific columns", () => {
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .returning("id");
    const result = q.compile(printer);
    expect(result.sql).toContain("RETURNING");
    expect(result.sql).toContain('"id"');
  });
});
