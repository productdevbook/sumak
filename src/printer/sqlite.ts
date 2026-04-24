import type {
  ArrayExprNode,
  BinaryOpNode,
  DeleteNode,
  FullTextSearchNode,
  InsertNode,
  JoinNode,
  QuantifiedExprNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { assertFeature } from "../dialect/features.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { quoteIdentifier } from "../utils/identifier.ts"
import { escapeStringLiteral } from "../utils/security.ts"
import { BasePrinter } from "./base.ts"

export class SqlitePrinter extends BasePrinter {
  constructor() {
    super("sqlite")
  }

  protected override printSelect(node: SelectNode): string {
    if (node.distinctOn) {
      assertFeature("sqlite", "DISTINCT_ON")
    }
    if (node.lock) {
      assertFeature("sqlite", "FOR_UPDATE")
    }
    return super.printSelect(node)
  }

  /**
   * SQLite does not support `LATERAL`. Reject instead of silently emitting
   * `INNER JOIN LATERAL (...)` which the driver would then reject at
   * execution time with a confusing generic error.
   */
  protected override printJoin(node: JoinNode): string {
    if (node.lateral) {
      assertFeature("sqlite", "LATERAL_JOIN")
    }
    return super.printJoin(node)
  }

  protected override printInsert(node: InsertNode): string {
    if (node.ctes.some((c) => c.recursive)) {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        "WITH RECURSIVE in INSERT (SQLite allows recursive CTEs only in SELECT)",
      )
    }
    return super.printInsert(node)
  }

  protected override printUpdate(node: UpdateNode): string {
    if (node.ctes.some((c) => c.recursive)) {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        "WITH RECURSIVE in UPDATE (SQLite allows recursive CTEs only in SELECT)",
      )
    }
    return super.printUpdate(node)
  }

  protected override printDelete(node: DeleteNode): string {
    if (node.ctes.some((c) => c.recursive)) {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        "WITH RECURSIVE in DELETE (SQLite allows recursive CTEs only in SELECT)",
      )
    }
    // SQLite has no multi-table DELETE (no USING, no JOIN). Reject
    // rather than silently emit SQL the parser rejects.
    if (node.using || node.joins.length > 0) {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        "multi-table DELETE (SQLite has no USING / JOIN on DELETE — rewrite as DELETE FROM t WHERE id IN (SELECT ...))",
      )
    }
    return super.printDelete(node)
  }

  /** SQLite has no `ARRAY[...]` literal syntax. */
  protected override printArrayExpr(_node: ArrayExprNode): string {
    throw new UnsupportedDialectFeatureError(
      "sqlite",
      "ARRAY[...] literal (SQLite has no array literal — use JSON arrays or raw SQL)",
    )
  }

  /** SQLite has no ANY/ALL quantified comparison. */
  protected override printQuantified(_node: QuantifiedExprNode): string {
    assertFeature("sqlite", "QUANTIFIED_SUBQUERY")
    return "" // unreachable — assertFeature throws
  }

  /** SQLite does not implement ANSI `MERGE`; use INSERT ... ON CONFLICT DO UPDATE. */
  protected override printMerge(_node: import("../ast/nodes.ts").MergeNode): string {
    throw new UnsupportedDialectFeatureError(
      "sqlite",
      "MERGE INTO (use INSERT ... ON CONFLICT DO UPDATE on SQLite)",
    )
  }

  /**
   * SQLite `->` / `->>` (3.38+) require the RHS to be a JSONPath
   * starting with `$` (`data->'$.name'`, `data->'$[0]'`). The base
   * printer emits PG's bare-key form, which SQLite rejects. Rewrite
   * the path literal here. `#>` / `#>>` are PG-specific — reject.
   */
  protected override printJsonAccess(node: import("../ast/nodes.ts").JsonAccessNode): string {
    if (node.operator === "#>" || node.operator === "#>>") {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        `${node.operator} JSON path operator — use json_extract(expr, '$.a.b') or chained '->' on SQLite`,
      )
    }
    const seg = /^\d+$/.test(node.path) ? `[${node.path}]` : `.${node.path}`
    const pathLiteral = `'$${escapeStringLiteral(seg)}'`
    const result = `${this.printExpression(node.expr)}${node.operator}${pathLiteral}`
    return node.alias ? `${result} AS ${quoteIdentifier(node.alias, this.dialect)}` : result
  }

  /**
   * SQLite's `EXPLAIN` returns bytecode opcodes (rarely what users
   * want); `EXPLAIN QUERY PLAN` is the form most callers mean. Neither
   * accepts `ANALYZE` or `(FORMAT …)` — both PG-specific. Reject the
   * PG options and point at raw SQL for the two SQLite forms.
   */
  protected override printExplain(node: import("../ast/nodes.ts").ExplainNode): string {
    if (node.analyze) {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        "EXPLAIN ANALYZE (SQLite has no equivalent — use EXPLAIN QUERY PLAN via raw SQL)",
      )
    }
    if (node.format) {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        "EXPLAIN (FORMAT ...) (SQLite only supports bare EXPLAIN and EXPLAIN QUERY PLAN)",
      )
    }
    return super.printExplain(node)
  }

  /**
   * SQLite has no scalar `GREATEST` / `LEAST`; `MAX(a, b, …)` /
   * `MIN(a, b, …)` with multiple arguments act as the scalar form
   * (the same names overload as aggregates when given one arg). Rewrite.
   * Note: SQLite's `MAX(a, NULL)` returns NULL while PG `GREATEST` skips
   * NULLs — callers relying on NULL-skipping semantics should use
   * `COALESCE(a, b)` explicitly.
   */
  protected override printFunctionCall(node: import("../ast/nodes.ts").FunctionCallNode): string {
    const upper = node.name.toUpperCase()
    // Only rewrite with 2+ args. Single-arg `MAX(expr)` / `MIN(expr)`
    // on SQLite is the AGGREGATE form, not the scalar — rewriting
    // `GREATEST(x)` (however degenerate) to `MAX(x)` would silently
    // collapse rows into an aggregate result. Refuse the 0/1-arg
    // variant with a clear error instead.
    if ((upper === "GREATEST" || upper === "LEAST") && node.args.length < 2) {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        `${upper} requires 2+ args on SQLite (single-arg MAX/MIN is the aggregate form, not scalar)`,
      )
    }
    if (upper === "GREATEST") {
      return super.printFunctionCall({ ...node, name: "MAX" })
    }
    if (upper === "LEAST") {
      return super.printFunctionCall({ ...node, name: "MIN" })
    }
    return super.printFunctionCall(node)
  }

  /**
   * SQLite has `IS` / `IS NOT` for null-safe equality but not
   * `IS [NOT] DISTINCT FROM`, and has no `ILIKE`. Reject both so
   * callers explicitly pick the SQLite-idiomatic form.
   */
  protected override printBinaryOp(node: BinaryOpNode): string {
    if (node.op === "IS NOT DISTINCT FROM") {
      // SQLite: `a IS b` IS already null-safe equality.
      return `(${this.printExpression(node.left)} IS ${this.printExpression(node.right)})`
    }
    if (node.op === "IS DISTINCT FROM") {
      return `(${this.printExpression(node.left)} IS NOT ${this.printExpression(node.right)})`
    }
    if (node.op === "ILIKE" || node.op === "NOT ILIKE") {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        `${node.op} (SQLite's LIKE is case-insensitive by default for ASCII — use plain LIKE)`,
      )
    }
    return super.printBinaryOp(node)
  }

  protected override printFullTextSearch(node: FullTextSearchNode): string {
    // SQLite FTS5: table MATCH query
    const col = node.columns.length > 0 ? this.printExpression(node.columns[0]) : "'*'"
    let result = `(${col} MATCH ${this.printExpression(node.query)})`
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }
}
