import { describe, expect, it } from "vitest";
import { mysqlDialect } from "../../src/dialect/mysql.ts";
import { select } from "../../src/builder/select.ts";

describe("mysqlDialect", () => {
  it("creates a dialect with name mysql", () => {
    const dialect = mysqlDialect();
    expect(dialect.name).toBe("mysql");
  });

  it("creates a MysqlPrinter", () => {
    const dialect = mysqlDialect();
    const printer = dialect.createPrinter();
    const result = printer.print(select("id").from("users").build());
    expect(result.sql).toContain("`id`");
  });
});
