import type {
  ASTNode,
  BetweenNode,
  BinaryOpNode,
  CastNode,
  ColumnRefNode,
  CTENode,
  DeleteNode,
  ExistsNode,
  ExpressionNode,
  FunctionCallNode,
  InNode,
  InsertNode,
  IsNullNode,
  JoinNode,
  LiteralNode,
  OrderByNode,
  ParamNode,
  RawNode,
  SelectNode,
  StarNode,
  SubqueryNode,
  TableRefNode,
  UnaryOpNode,
  UpdateNode,
} from "../ast/nodes.ts";
import type { CompiledQuery, SQLDialect } from "../types.ts";
import { quoteIdentifier, quoteTableRef } from "../utils/identifier.ts";
import { formatParam } from "../utils/param.ts";
import type { Printer } from "./types.ts";

export class BasePrinter implements Printer {
  protected params: unknown[] = [];
  protected dialect: SQLDialect;

  constructor(dialect: SQLDialect) {
    this.dialect = dialect;
  }

  print(node: ASTNode): CompiledQuery {
    this.params = [];
    const sql = this.printNode(node);
    return { sql, params: [...this.params] };
  }

  protected printNode(node: ASTNode): string {
    switch (node.type) {
      case "select":
        return this.printSelect(node);
      case "insert":
        return this.printInsert(node);
      case "update":
        return this.printUpdate(node);
      case "delete":
        return this.printDelete(node);
      default:
        return this.printExpression(node);
    }
  }

  protected printSelect(node: SelectNode): string {
    const parts: string[] = [];

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes));
    }

    parts.push("SELECT");

    if (node.distinct) {
      parts.push("DISTINCT");
    }

    if (node.columns.length === 0) {
      parts.push("*");
    } else {
      parts.push(node.columns.map((c) => this.printExpression(c)).join(", "));
    }

    if (node.from) {
      parts.push("FROM");
      if (node.from.type === "subquery") {
        parts.push(this.printSubquery(node.from));
      } else {
        parts.push(this.printTableRef(node.from));
      }
    }

    for (const join of node.joins) {
      parts.push(this.printJoin(join));
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where));
    }

    if (node.groupBy.length > 0) {
      parts.push("GROUP BY", node.groupBy.map((g) => this.printExpression(g)).join(", "));
    }

    if (node.having) {
      parts.push("HAVING", this.printExpression(node.having));
    }

    if (node.orderBy.length > 0) {
      parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "));
    }

    if (node.limit) {
      parts.push("LIMIT", this.printExpression(node.limit));
    }

    if (node.offset) {
      parts.push("OFFSET", this.printExpression(node.offset));
    }

    if (node.setOp) {
      parts.push(node.setOp.op, this.printSelect(node.setOp.query));
    }

    if (node.forUpdate) {
      parts.push("FOR UPDATE");
    }

    return parts.join(" ");
  }

  protected printInsert(node: InsertNode): string {
    const parts: string[] = [];

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes));
    }

    parts.push("INSERT INTO", this.printTableRef(node.table));

    if (node.columns.length > 0) {
      parts.push(`(${node.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")})`);
    }

    parts.push("VALUES");
    const rows = node.values.map(
      (row) => `(${row.map((v) => this.printExpression(v)).join(", ")})`,
    );
    parts.push(rows.join(", "));

    if (node.onConflict) {
      parts.push(this.printOnConflict(node.onConflict));
    }

    if (node.returning.length > 0) {
      parts.push("RETURNING", node.returning.map((r) => this.printExpression(r)).join(", "));
    }

    return parts.join(" ");
  }

  protected printOnConflict(node: import("../ast/nodes.ts").OnConflictNode): string {
    const parts: string[] = ["ON CONFLICT"];

    if (node.columns.length > 0) {
      parts.push(`(${node.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")})`);
    }

    if (node.action === "nothing") {
      parts.push("DO NOTHING");
    } else {
      parts.push("DO UPDATE SET");
      const sets = node.action.set.map(
        (s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`,
      );
      parts.push(sets.join(", "));
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where));
    }

    return parts.join(" ");
  }

  protected printUpdate(node: UpdateNode): string {
    const parts: string[] = [];

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes));
    }

    parts.push("UPDATE", this.printTableRef(node.table), "SET");

    const sets = node.set.map(
      (s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`,
    );
    parts.push(sets.join(", "));

    if (node.from) {
      parts.push("FROM", this.printTableRef(node.from));
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where));
    }

    if (node.returning.length > 0) {
      parts.push("RETURNING", node.returning.map((r) => this.printExpression(r)).join(", "));
    }

    return parts.join(" ");
  }

  protected printDelete(node: DeleteNode): string {
    const parts: string[] = [];

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes));
    }

    parts.push("DELETE FROM", this.printTableRef(node.table));

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where));
    }

    if (node.returning.length > 0) {
      parts.push("RETURNING", node.returning.map((r) => this.printExpression(r)).join(", "));
    }

    return parts.join(" ");
  }

  protected printExpression(node: ExpressionNode): string {
    switch (node.type) {
      case "column_ref":
        return this.printColumnRef(node);
      case "literal":
        return this.printLiteral(node);
      case "binary_op":
        return this.printBinaryOp(node);
      case "unary_op":
        return this.printUnaryOp(node);
      case "function_call":
        return this.printFunctionCall(node);
      case "param":
        return this.printParam(node);
      case "raw":
        return this.printRaw(node);
      case "subquery":
        return this.printSubquery(node);
      case "between":
        return this.printBetween(node);
      case "in":
        return this.printIn(node);
      case "is_null":
        return this.printIsNull(node);
      case "cast":
        return this.printCast(node);
      case "exists":
        return this.printExists(node);
      case "star":
        return this.printStar(node);
      case "case":
        return this.printCase(node);
    }
  }

  protected printColumnRef(node: ColumnRefNode): string {
    let result = node.table
      ? `${quoteIdentifier(node.table, this.dialect)}.${quoteIdentifier(node.column, this.dialect)}`
      : quoteIdentifier(node.column, this.dialect);

    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`;
    }
    return result;
  }

  protected printLiteral(node: LiteralNode): string {
    if (node.value === null) return "NULL";
    if (typeof node.value === "boolean") return node.value ? "TRUE" : "FALSE";
    if (typeof node.value === "number") return String(node.value);
    return `'${String(node.value).replaceAll("'", "''")}'`;
  }

  protected printBinaryOp(node: BinaryOpNode): string {
    return `(${this.printExpression(node.left)} ${node.op} ${this.printExpression(node.right)})`;
  }

  protected printUnaryOp(node: UnaryOpNode): string {
    if (node.position === "postfix") {
      return `(${this.printExpression(node.operand)} ${node.op})`;
    }
    return `(${node.op} ${this.printExpression(node.operand)})`;
  }

  protected printFunctionCall(node: FunctionCallNode): string {
    let result = `${node.name}(${node.args.map((a) => this.printExpression(a)).join(", ")})`;
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`;
    }
    return result;
  }

  protected printParam(node: ParamNode): string {
    this.params.push(node.value);
    return formatParam(this.params.length - 1, this.dialect);
  }

  protected printRaw(node: RawNode): string {
    this.params.push(...node.params);
    return node.sql;
  }

  protected printSubquery(node: SubqueryNode): string {
    let result = `(${this.printSelect(node.query)})`;
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`;
    }
    return result;
  }

  protected printBetween(node: BetweenNode): string {
    const neg = node.negated ? "NOT " : "";
    return `(${this.printExpression(node.expr)} ${neg}BETWEEN ${this.printExpression(node.low)} AND ${this.printExpression(node.high)})`;
  }

  protected printIn(node: InNode): string {
    const neg = node.negated ? "NOT " : "";
    if (Array.isArray(node.values)) {
      return `(${this.printExpression(node.expr)} ${neg}IN (${node.values.map((v) => this.printExpression(v)).join(", ")}))`;
    }
    return `(${this.printExpression(node.expr)} ${neg}IN (${this.printSelect(node.values)}))`;
  }

  protected printIsNull(node: IsNullNode): string {
    const neg = node.negated ? " NOT" : "";
    return `(${this.printExpression(node.expr)} IS${neg} NULL)`;
  }

  protected printCase(node: import("../ast/nodes.ts").CaseNode): string {
    const parts: string[] = ["CASE"];
    if (node.operand) {
      parts.push(this.printExpression(node.operand));
    }
    for (const when of node.whens) {
      parts.push(
        "WHEN",
        this.printExpression(when.condition),
        "THEN",
        this.printExpression(when.result),
      );
    }
    if (node.else_) {
      parts.push("ELSE", this.printExpression(node.else_));
    }
    parts.push("END");
    return parts.join(" ");
  }

  protected printCast(node: CastNode): string {
    return `CAST(${this.printExpression(node.expr)} AS ${node.dataType})`;
  }

  protected printExists(node: ExistsNode): string {
    const neg = node.negated ? "NOT " : "";
    return `(${neg}EXISTS (${this.printSelect(node.query)}))`;
  }

  protected printStar(node: StarNode): string {
    return node.table ? `${quoteIdentifier(node.table, this.dialect)}.*` : "*";
  }

  protected printTableRef(ref: TableRefNode): string {
    let result = quoteTableRef(ref.name, this.dialect, ref.schema);
    if (ref.alias) {
      result += ` AS ${quoteIdentifier(ref.alias, this.dialect)}`;
    }
    return result;
  }

  protected printJoin(node: JoinNode): string {
    const parts: string[] = [];
    parts.push(`${node.joinType} JOIN`);

    if (node.table.type === "subquery") {
      parts.push(this.printSubquery(node.table));
    } else {
      parts.push(this.printTableRef(node.table));
    }

    if (node.on) {
      parts.push("ON", this.printExpression(node.on));
    }

    return parts.join(" ");
  }

  protected printOrderBy(node: OrderByNode): string {
    let result = `${this.printExpression(node.expr)} ${node.direction}`;
    if (node.nulls) {
      result += ` NULLS ${node.nulls}`;
    }
    return result;
  }

  protected printCTEs(ctes: CTENode[]): string {
    const hasRecursive = ctes.some((c) => c.recursive);
    const prefix = hasRecursive ? "WITH RECURSIVE" : "WITH";
    const cteParts = ctes.map(
      (c) => `${quoteIdentifier(c.name, this.dialect)} AS (${this.printSelect(c.query)})`,
    );
    return `${prefix} ${cteParts.join(", ")}`;
  }
}
