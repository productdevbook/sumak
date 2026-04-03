import { describe, expect, it } from "vitest";
import {
  and,
  between,
  col,
  eq,
  exists,
  gt,
  gte,
  inList,
  isNull,
  like,
  lit,
  lt,
  lte,
  neq,
  not,
  or,
} from "../../src/ast/expression.ts";
import { createSelectNode } from "../../src/ast/nodes.ts";
import { PgPrinter } from "../../src/printer/pg.ts";

const pg = new PgPrinter();

function printExpr(expr: import("../../src/ast/nodes.ts").ExpressionNode): string {
  const node = createSelectNode();
  node.columns = [expr];
  node.from = { name: "dual" };
  return pg.print(node).sql;
}

describe("Expression builders", () => {
  it("col creates column reference", () => {
    const expr = col("name");
    expect(expr.type).toBe("column_ref");
    expect(expr.column).toBe("name");
  });

  it("col with table", () => {
    const expr = col("name", "users");
    expect(expr.table).toBe("users");
  });

  it("lit creates literal", () => {
    expect(lit(42).value).toBe(42);
    expect(lit("hello").value).toBe("hello");
    expect(lit(null).value).toBe(null);
    expect(lit(true).value).toBe(true);
  });

  it("eq creates equality", () => {
    const sql = printExpr(eq(col("id"), lit(1)));
    expect(sql).toContain('("id" = 1)');
  });

  it("neq creates not-equal", () => {
    const sql = printExpr(neq(col("id"), lit(1)));
    expect(sql).toContain('("id" != 1)');
  });

  it("gt, gte, lt, lte create comparisons", () => {
    expect(printExpr(gt(col("age"), lit(18)))).toContain(">");
    expect(printExpr(gte(col("age"), lit(18)))).toContain(">=");
    expect(printExpr(lt(col("age"), lit(18)))).toContain("<");
    expect(printExpr(lte(col("age"), lit(18)))).toContain("<=");
  });

  it("and combines expressions", () => {
    const sql = printExpr(and(eq(col("a"), lit(1)), eq(col("b"), lit(2))));
    expect(sql).toContain("AND");
  });

  it("or combines expressions", () => {
    const sql = printExpr(or(eq(col("a"), lit(1)), eq(col("b"), lit(2))));
    expect(sql).toContain("OR");
  });

  it("like creates LIKE expression", () => {
    const sql = printExpr(like(col("name"), lit("%alice%")));
    expect(sql).toContain("LIKE");
  });

  it("between creates BETWEEN expression", () => {
    const sql = printExpr(between(col("age"), lit(18), lit(65)));
    expect(sql).toContain("BETWEEN");
  });

  it("between negated creates NOT BETWEEN", () => {
    const sql = printExpr(between(col("age"), lit(18), lit(65), true));
    expect(sql).toContain("NOT BETWEEN");
  });

  it("inList creates IN expression", () => {
    const sql = printExpr(inList(col("id"), [lit(1), lit(2), lit(3)]));
    expect(sql).toContain("IN");
  });

  it("inList negated creates NOT IN", () => {
    const sql = printExpr(inList(col("id"), [lit(1)], true));
    expect(sql).toContain("NOT IN");
  });

  it("isNull creates IS NULL", () => {
    const sql = printExpr(isNull(col("deleted_at")));
    expect(sql).toContain("IS NULL");
  });

  it("isNull negated creates IS NOT NULL", () => {
    const sql = printExpr(isNull(col("deleted_at"), true));
    expect(sql).toContain("IS NOT NULL");
  });

  it("not creates NOT expression", () => {
    const expr = not(eq(col("active"), lit(true)));
    expect(expr.type).toBe("unary_op");
    expect(expr.op).toBe("NOT");
  });

  it("exists creates EXISTS", () => {
    const subq = createSelectNode();
    subq.columns = [lit(1)];
    subq.from = { name: "users" };
    const sql = printExpr(exists(subq));
    expect(sql).toContain("EXISTS");
  });
});
