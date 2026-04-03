import { describe, expect, expectTypeOf, it } from "vitest";
import {
  typedAdd,
  typedAnd,
  typedBetween,
  typedCol,
  typedDiv,
  typedEq,
  typedGt,
  typedGte,
  typedIn,
  typedIsNotNull,
  typedIsNull,
  typedLike,
  typedLit,
  typedLt,
  typedLte,
  typedMul,
  typedNeq,
  typedNot,
  typedOr,
  typedParam,
  typedSub,
  unwrap,
} from "../../src/ast/typed-expression.ts";
import type { Expression } from "../../src/ast/typed-expression.ts";
import { PgPrinter } from "../../src/printer/pg.ts";
import { createSelectNode } from "../../src/ast/nodes.ts";
import type { SelectNode } from "../../src/ast/nodes.ts";

const pg = new PgPrinter();

function printExpr(e: Expression<any>): string {
  const node: SelectNode = {
    ...createSelectNode(),
    columns: [unwrap(e)],
    from: { type: "table_ref", name: "t" },
  };
  return pg.print(node).sql;
}

describe("Expression<T> phantom types", () => {
  describe("type safety", () => {
    it("typedCol carries type parameter", () => {
      const e = typedCol<number>("id");
      expectTypeOf(e).toMatchTypeOf<Expression<number>>();
    });

    it("typedLit carries type parameter", () => {
      const e = typedLit(42);
      expectTypeOf(e).toMatchTypeOf<Expression<number>>();
    });

    it("typedLit with string", () => {
      const e = typedLit("hello");
      expectTypeOf(e).toMatchTypeOf<Expression<string>>();
    });

    it("typedLit with boolean", () => {
      const e = typedLit(true);
      expectTypeOf(e).toMatchTypeOf<Expression<boolean>>();
    });

    it("typedEq returns Expression<boolean>", () => {
      const result = typedEq(typedCol<number>("id"), typedLit(1));
      expectTypeOf(result).toMatchTypeOf<Expression<boolean>>();
    });

    it("typedAnd requires Expression<boolean> operands", () => {
      const a = typedEq(typedCol<number>("x"), typedLit(1));
      const b = typedEq(typedCol<number>("y"), typedLit(2));
      const result = typedAnd(a, b);
      expectTypeOf(result).toMatchTypeOf<Expression<boolean>>();
    });

    it("typedAdd returns Expression<number>", () => {
      const result = typedAdd(typedCol<number>("a"), typedCol<number>("b"));
      expectTypeOf(result).toMatchTypeOf<Expression<number>>();
    });
  });

  describe("SQL generation", () => {
    it("typedEq generates correct SQL", () => {
      const e = typedEq(typedCol<number>("id"), typedParam(0, 42));
      const sql = printExpr(e);
      expect(sql).toContain('("id" = $1)');
    });

    it("typedNeq generates !=", () => {
      const e = typedNeq(typedCol<number>("id"), typedLit(1));
      expect(printExpr(e)).toContain("!=");
    });

    it("typedGt generates >", () => {
      const e = typedGt(typedCol<number>("age"), typedLit(18));
      expect(printExpr(e)).toContain(">");
    });

    it("typedGte generates >=", () => {
      const e = typedGte(typedCol<number>("age"), typedLit(18));
      expect(printExpr(e)).toContain(">=");
    });

    it("typedLt generates <", () => {
      const e = typedLt(typedCol<number>("age"), typedLit(18));
      expect(printExpr(e)).toContain("<");
    });

    it("typedLte generates <=", () => {
      const e = typedLte(typedCol<number>("age"), typedLit(18));
      expect(printExpr(e)).toContain("<=");
    });

    it("typedLike generates LIKE", () => {
      const e = typedLike(typedCol<string>("name"), typedLit("%alice%"));
      expect(printExpr(e)).toContain("LIKE");
    });

    it("typedBetween generates BETWEEN", () => {
      const e = typedBetween(typedCol<number>("age"), typedLit(18), typedLit(65));
      expect(printExpr(e)).toContain("BETWEEN");
    });

    it("typedIn generates IN", () => {
      const e = typedIn(typedCol<number>("id"), [typedLit(1), typedLit(2), typedLit(3)]);
      expect(printExpr(e)).toContain("IN");
    });

    it("typedIsNull generates IS NULL", () => {
      const e = typedIsNull(typedCol<string | null>("deleted_at"));
      expect(printExpr(e)).toContain("IS NULL");
    });

    it("typedIsNotNull generates IS NOT NULL", () => {
      const e = typedIsNotNull(typedCol<string | null>("deleted_at"));
      expect(printExpr(e)).toContain("IS NOT NULL");
    });

    it("typedAnd generates AND", () => {
      const a = typedEq(typedCol<number>("x"), typedLit(1));
      const b = typedEq(typedCol<number>("y"), typedLit(2));
      expect(printExpr(typedAnd(a, b))).toContain("AND");
    });

    it("typedOr generates OR", () => {
      const a = typedEq(typedCol<number>("x"), typedLit(1));
      const b = typedEq(typedCol<number>("y"), typedLit(2));
      expect(printExpr(typedOr(a, b))).toContain("OR");
    });

    it("typedNot generates NOT", () => {
      const a = typedEq(typedCol<boolean>("active"), typedLit(true));
      expect(printExpr(typedNot(a))).toContain("NOT");
    });

    it("typedAdd generates +", () => {
      const e = typedAdd(typedCol<number>("a"), typedCol<number>("b"));
      expect(printExpr(e)).toContain("+");
    });

    it("typedSub generates -", () => {
      const e = typedSub(typedCol<number>("a"), typedLit(1));
      expect(printExpr(e)).toContain("-");
    });

    it("typedMul generates *", () => {
      const e = typedMul(typedCol<number>("price"), typedCol<number>("qty"));
      expect(printExpr(e)).toContain("*");
    });

    it("typedDiv generates /", () => {
      const e = typedDiv(typedCol<number>("total"), typedLit(2));
      expect(printExpr(e)).toContain("/");
    });
  });

  describe("unwrap", () => {
    it("returns the underlying ExpressionNode", () => {
      const e = typedCol<number>("id");
      const node = unwrap(e);
      expect(node.type).toBe("column_ref");
    });

    it("preserves params", () => {
      const e = typedParam<number>(0, 42);
      const node = unwrap(e);
      expect(node.type).toBe("param");
    });
  });
});
