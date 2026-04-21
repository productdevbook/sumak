import type {
  DeleteNode,
  FullTextSearchNode,
  InsertNode,
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
      parts.push(node.setOp.op, this.printSelect(node.setOp.query))
    }

    if (node.orderBy.length > 0) {
      parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
    }

    // MSSQL: OFFSET/FETCH instead of LIMIT/OFFSET (requires ORDER BY).
    // When a set-op is present we couldn't emit TOP (it would bind to the
    // left arm only), so any `.limit()` must land here as a FETCH clause
    // even without an explicit OFFSET.
    if (node.offset || (node.limit && node.setOp)) {
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

    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    const insertKeyword = node.insertMode ?? "INSERT"
    parts.push(`${insertKeyword} INTO`, this.printTableRef(node.table))

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
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("DELETE FROM", this.printTableRef(node.table))

    // MSSQL: OUTPUT instead of RETURNING
    if (node.returning.length > 0) {
      parts.push("OUTPUT", this._outputCols(node.returning, "DELETED"))
    }

    for (const join of node.joins) {
      parts.push(this.printJoin(join))
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
}
