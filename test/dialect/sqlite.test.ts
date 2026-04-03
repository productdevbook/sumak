import { describe, expect, it } from "vitest";
import { sqliteDialect } from "../../src/dialect/sqlite.ts";
import { select } from "../../src/builder/select.ts";

describe("sqliteDialect", () => {
  it("creates a dialect with name sqlite", () => {
    const dialect = sqliteDialect();
    expect(dialect.name).toBe("sqlite");
  });

  it("creates a SqlitePrinter", () => {
    const dialect = sqliteDialect();
    const printer = dialect.createPrinter();
    const result = printer.print(select("id").from("users").build());
    expect(result.sql).toContain('"id"');
  });
});
