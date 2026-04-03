import { describe, expect, it } from "vitest";
import { pgDialect } from "../../src/dialect/pg.ts";
import { select } from "../../src/builder/select.ts";

describe("pgDialect", () => {
  it("creates a dialect with name pg", () => {
    const dialect = pgDialect();
    expect(dialect.name).toBe("pg");
  });

  it("creates a PgPrinter", () => {
    const dialect = pgDialect();
    const printer = dialect.createPrinter();
    const result = printer.print(select("id").from("users").build());
    expect(result.sql).toContain('"id"');
  });
});
