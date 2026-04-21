import type {
  BinaryOpNode,
  CTENode,
  DeleteNode,
  FullTextSearchNode,
  FunctionCallNode,
  InsertNode,
  JsonAccessNode,
  LiteralNode,
  OrderByNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { quoteIdentifier } from "../utils/identifier.ts"
import { BasePrinter } from "./base.ts"

export class MssqlPrinter extends BasePrinter {
  constructor() {
    super("mssql")
  }

  protected override printSelect(node: SelectNode): string {
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    if (node.distinctOn) {
      throw new UnsupportedDialectFeatureError("mssql", "DISTINCT ON")
    }

    parts.push("SELECT")

    if (node.distinct) {
      parts.push("DISTINCT")
    }

    // MSSQL: TOP N instead of LIMIT (only when no OFFSET and no set-op).
    // `SELECT TOP 10 ... UNION SELECT ...` applies TOP only to the left
    // arm on SQL Server — silently returns fewer rows than the user
    // expected. For UNION with a limit, the outer query uses
    // `OFFSET 0 ROWS FETCH NEXT N ROWS ONLY` instead; when there's no
    // set-op we still prefer the shorter `TOP N` form.
    if (node.limit && !node.offset && !node.setOp) {
      parts.push(`TOP ${this.printExpression(node.limit)}`)
    }

    if (node.columns.length === 0) {
      parts.push("*")
    } else {
      parts.push(node.columns.map((c) => this.printExpression(c)).join(", "))
    }

    if (node.from) {
      parts.push("FROM")
      if (node.from.type === "subquery") {
        parts.push(this.printSubquery(node.from))
      } else if (node.from.type === "graph_table") {
        parts.push(this.printGraphTable(node.from))
      } else {
        parts.push(this.printTableRef(node.from))
      }
    }

    for (const join of node.joins) {
      parts.push(this.printJoin(join))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    if (node.groupBy.length > 0) {
      parts.push("GROUP BY", node.groupBy.map((g) => this.printExpression(g)).join(", "))
    }

    if (node.having) {
      parts.push("HAVING", this.printExpression(node.having))
    }

    // MSSQL: UNION / INTERSECT / EXCEPT come between HAVING and ORDER BY —
    // the outer query's ORDER BY + OFFSET/FETCH apply to the combined
    // result, not to the left arm. Emitting OFFSET/FETCH before the
    // set-op was invalid SQL (SQL Server rejects the statement).
    if (node.setOp) {
      // Wrap the inner SELECT in parens when it carries its own
      // ORDER BY / OFFSET / FETCH (LIMIT) — without parens those
      // clauses bind to the combined result on SQL Server, not to
      // the inner arm, silently changing what the caller asked for.
      const inner = node.setOp.query
      const innerHasPagination =
        inner.orderBy.length > 0 || inner.limit !== undefined || inner.offset !== undefined
      const printedInner = this.printSelect(inner)
      parts.push(node.setOp.op, innerHasPagination ? `(${printedInner})` : printedInner)
    }

    if (node.orderBy.length > 0) {
      parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
    }

    // MSSQL: OFFSET/FETCH instead of LIMIT/OFFSET (requires ORDER BY).
    // When a set-op is present we couldn't emit TOP (it would bind to the
    // left arm only), so any `.limit()` must land here as a FETCH clause
    // even without an explicit OFFSET.
    // Treat literal-zero offset as "no pagination": `.offset(0)` as a
    // no-op (for a stable pagination API across dialects) should not
    // force an ORDER BY requirement when no LIMIT is present.
    const isZeroOffset =
      node.offset?.type === "literal" && (node.offset as { value: unknown }).value === 0
    const needsOffsetFetch =
      (node.offset && !(isZeroOffset && !node.limit)) || (node.limit && node.setOp)
    if (needsOffsetFetch) {
      if (node.orderBy.length === 0) {
        throw new UnsupportedDialectFeatureError(
          "mssql",
          "OFFSET/FETCH requires ORDER BY on SQL Server — add .orderBy(...) before .offset()/.limit()",
        )
      }
      const off = node.offset ?? { type: "literal" as const, value: 0 }
      parts.push(`OFFSET ${this.printExpression(off)} ROWS`)
      if (node.limit) {
        parts.push(`FETCH NEXT ${this.printExpression(node.limit)} ROWS ONLY`)
      }
    }

    if (node.lock) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "FOR UPDATE/SHARE (use WITH (UPDLOCK) hints instead)",
      )
    }

    return parts.join(" ")
  }

  /**
   * SQL Server supports recursive CTEs but does not accept the
   * `RECURSIVE` keyword — `WITH cte AS (...)` is used for both recursive
   * and non-recursive CTEs. Emitting `WITH RECURSIVE` is a syntax error.
   */
  protected override printCTEs(ctes: CTENode[]): string {
    const cteParts = ctes.map(
      (c) => `${quoteIdentifier(c.name, this.dialect)} AS (${this.printSelect(c.query)})`,
    )
    return `WITH ${cteParts.join(", ")}`
  }

  /**
   * SQL Server has no boolean type — `TRUE` / `FALSE` are not literals,
   * they are identifiers (and unbound ones). Boolean literals must be
   * emitted as `1` / `0` (the BIT domain). Every path that routes
   * through `printLiteral` (bare `lit(true)`, `IS NOT DISTINCT FROM
   * true`, `CASE WHEN … THEN true`, etc.) otherwise produces
   * unexecutable SQL.
   */
  protected override printLiteral(node: LiteralNode): string {
    if (typeof node.value === "boolean") return node.value ? "1" : "0"
    return super.printLiteral(node)
  }

  /**
   * SQL Server has no `EXPLAIN` keyword; query plans are obtained via
   * session-scoped `SET SHOWPLAN_ALL ON` (text plan) / `SET STATISTICS
   * PROFILE ON` (runtime stats). Neither is a prefix on the statement,
   * so there's no clean translation — refuse with a pointer.
   */
  protected override printExplain(_node: import("../ast/nodes.ts").ExplainNode): string {
    throw new UnsupportedDialectFeatureError(
      "mssql",
      "EXPLAIN (SQL Server uses session-scoped SET SHOWPLAN_ALL ON or SET STATISTICS PROFILE ON — emit those separately)",
    )
  }

  /**
   * SQL Server has no `->` / `->>` / `#>` / `#>>` operators — it uses
   * `JSON_VALUE(expr, '$.path')` for scalar extraction and
   * `JSON_QUERY(expr, '$.path')` for JSON-typed extraction. The base
   * printer would otherwise emit PG operators verbatim; the driver
   * rejects the statement at parse. Rather than silently translate
   * (the two forms differ on array-vs-scalar semantics), reject with
   * a message pointing at the right MSSQL function.
   */
  protected override printJsonAccess(_node: JsonAccessNode): string {
    throw new UnsupportedDialectFeatureError(
      "mssql",
      "JSON path operators (->, ->>, #>, #>>) — use JSON_VALUE(expr, '$.path') for scalars or JSON_QUERY(expr, '$.path') for objects/arrays via sql`…`",
    )
  }

  protected override printGraphTable(
    _node: import("../ast/graph-nodes.ts").GraphTableNode,
  ): string {
    throw new UnsupportedDialectFeatureError(
      "mssql",
      "SQL:2023 GRAPH_TABLE (MSSQL has its own node/edge MATCH() graph syntax — not the SQL/PGQ standard)",
    )
  }

  /**
   * MSSQL does not support `LATERAL` — it has `CROSS APPLY` / `OUTER
   * APPLY` which are semantically similar but syntactically different.
   * Throw rather than silently emit invalid SQL; users who need the
   * correlated-subquery pattern on MSSQL should use raw SQL for now.
   */
  protected override printJoin(node: import("../ast/nodes.ts").JoinNode): string {
    if (node.lateral) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "LATERAL JOIN (use CROSS APPLY / OUTER APPLY via raw SQL)",
      )
    }
    return super.printJoin(node)
  }

  protected override printInsert(node: InsertNode): string {
    if (node.onConflict) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "ON CONFLICT (use MERGE for upsert in MSSQL)",
      )
    }
    if (node.insertMode && node.insertMode !== "INSERT") {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        `${node.insertMode} (SQLite-only syntax — use MERGE INTO for MSSQL upserts)`,
      )
    }

    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("INSERT INTO", this.printTableRef(node.table))

    if (node.columns.length > 0) {
      parts.push(`(${node.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")})`)
    }

    // MSSQL: OUTPUT instead of RETURNING
    if (node.returning.length > 0) {
      parts.push("OUTPUT", this._outputCols(node.returning, "INSERTED"))
    }

    if (node.defaultValues) {
      parts.push("DEFAULT VALUES")
    } else if (node.source) {
      parts.push(this.printSelect(node.source))
    } else {
      parts.push("VALUES")
      const rows = node.values.map(
        (row) => `(${row.map((v) => this.printExpression(v)).join(", ")})`,
      )
      parts.push(rows.join(", "))
    }

    return parts.join(" ")
  }

  protected override printUpdate(node: UpdateNode): string {
    // SQL Server does not support UPDATE ... ORDER BY / LIMIT directly;
    // silently dropping either (as the base printer's inherited behavior
    // would) emits a much more permissive statement than the caller
    // wrote — an UPDATE intended to bound rows modifies the entire
    // matched set. Reject explicitly with a CTE/TOP-shaped hint.
    if (node.limit || (node.orderBy && node.orderBy.length > 0)) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "UPDATE with LIMIT/ORDER BY — use a CTE: WITH cte AS (SELECT TOP N ... ORDER BY ...) UPDATE cte SET ...",
      )
    }
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("UPDATE", this.printTableRef(node.table), "SET")

    const sets = node.set.map(
      (s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`,
    )
    parts.push(sets.join(", "))

    // MSSQL: OUTPUT instead of RETURNING
    if (node.returning.length > 0) {
      parts.push("OUTPUT", this._outputCols(node.returning, "INSERTED"))
    }

    // MSSQL `UPDATE t SET ... FROM t INNER JOIN ... WHERE`: FROM precedes JOINs.
    if (node.from) {
      parts.push("FROM", this.printTableRef(node.from))
    }

    for (const join of node.joins) {
      parts.push(this.printJoin(join))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    return parts.join(" ")
  }

  protected override printDelete(node: DeleteNode): string {
    if (node.limit || (node.orderBy && node.orderBy.length > 0)) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "DELETE with LIMIT/ORDER BY — use a CTE: WITH cte AS (SELECT TOP N ... ORDER BY ...) DELETE FROM cte",
      )
    }
    if (node.using) {
      // MSSQL has no `DELETE FROM t USING other`; multi-table form is
      // `DELETE t FROM t JOIN other …`. Point the caller at innerJoin
      // rather than silently emitting PG-flavoured invalid SQL.
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "DELETE ... USING (use .innerJoin(other, on) — SQL Server multi-table form is `DELETE t FROM t JOIN other`)",
      )
    }
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    // MSSQL multi-table DELETE: `DELETE <target> FROM <target> <joins>`.
    // The target alias (or bare name) precedes FROM; the base printer's
    // `DELETE FROM t INNER JOIN …` form is a MSSQL parse error.
    if (node.joins.length > 0) {
      const tableName = node.table.alias ?? node.table.name
      parts.push("DELETE", quoteIdentifier(tableName, this.dialect))
      // MSSQL: OUTPUT sits between target and FROM on delete-with-join.
      if (node.returning.length > 0) {
        parts.push("OUTPUT", this._outputCols(node.returning, "DELETED"))
      }
      parts.push("FROM", this.printTableRef(node.table))
      for (const join of node.joins) parts.push(this.printJoin(join))
      if (node.where) parts.push("WHERE", this.printExpression(node.where))
      return parts.join(" ")
    }

    parts.push("DELETE FROM", this.printTableRef(node.table))

    // MSSQL: OUTPUT instead of RETURNING
    if (node.returning.length > 0) {
      parts.push("OUTPUT", this._outputCols(node.returning, "DELETED"))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    return parts.join(" ")
  }

  /**
   * Render a RETURNING list as MSSQL `OUTPUT` columns under the given
   * pseudo-table (`INSERTED` or `DELETED`). Handles `StarNode` bare and
   * table-qualified — previously a `printed === "*"` string check missed
   * the `"t".*` form and emitted invalid `OUTPUT INSERTED."t".*`.
   */
  private _outputCols(
    returning: readonly import("../ast/nodes.ts").ExpressionNode[],
    prefix: "INSERTED" | "DELETED",
  ): string {
    return returning
      .map((r) => {
        if (r.type === "star") {
          return r.table ? `${prefix}.${quoteIdentifier(r.table, this.dialect)}.*` : `${prefix}.*`
        }
        return `${prefix}.${this.printExpression(r)}`
      })
      .join(", ")
  }

  protected override printFullTextSearch(node: FullTextSearchNode): string {
    const cols = node.columns.map((c) => this.printExpression(c)).join(", ")
    const query = this.printExpression(node.query)
    const fn = node.mode === "natural" ? "FREETEXT" : "CONTAINS"
    let result = `${fn}((${cols}), ${query})`
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }

  /**
   * MSSQL has no standard `NULLS FIRST / LAST` — SQL Server 2022 added
   * a variant but widely-deployed versions don't support it. Refuse
   * rather than emit invalid SQL; callers can use a CASE expression
   * or `ISNULL(col, ...)` as a secondary sort key instead.
   */
  protected override printOrderBy(node: OrderByNode): string {
    if (node.nulls) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "NULLS FIRST/LAST in ORDER BY (use a CASE expression as a secondary sort key)",
      )
    }
    return super.printOrderBy(node)
  }

  /**
   * MSSQL has no `IS [NOT] DISTINCT FROM` pre-2022 and no `ILIKE`.
   * Refuse; callers can rewrite via `CASE WHEN ... IS NULL THEN ...`
   * or `COLLATE` clauses respectively.
   */
  protected override printBinaryOp(node: BinaryOpNode): string {
    if (node.op === "IS DISTINCT FROM" || node.op === "IS NOT DISTINCT FROM") {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        `${node.op} (MSSQL pre-2022 has no equivalent — use CASE WHEN with IS NULL guards)`,
      )
    }
    if (node.op === "ILIKE" || node.op === "NOT ILIKE") {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        `${node.op} (use LIKE with a case-insensitive COLLATE clause)`,
      )
    }
    return super.printBinaryOp(node)
  }

  /**
   * SQL Server does not support `<agg> FILTER (WHERE ...)`. Rewriting to
   * `COUNT(CASE WHEN ... END)` changes NULL-handling subtly (COUNT skips
   * nulls; the CASE produces nulls), so we refuse and point the caller
   * at an explicit rewrite.
   */
  protected override printFunctionCall(node: FunctionCallNode): string {
    if (node.filter) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "FILTER (WHERE ...) aggregate clause (rewrite as COUNT(CASE WHEN ... THEN 1 END) or SUM(CASE ...))",
      )
    }
    return super.printFunctionCall(node)
  }
}
