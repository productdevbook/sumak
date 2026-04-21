import type {
  ArrayExprNode,
  BinaryOpNode,
  DeleteNode,
  FullTextSearchNode,
  InsertNode,
  JoinNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { quoteIdentifier } from "../utils/identifier.ts"
import { BasePrinter } from "./base.ts"

export class SqlitePrinter extends BasePrinter {
  constructor() {
    super("sqlite")
  }

  protected override printSelect(node: SelectNode): string {
    if (node.distinctOn) {
      throw new UnsupportedDialectFeatureError("sqlite", "DISTINCT ON")
    }
    if (node.lock) {
      throw new UnsupportedDialectFeatureError("sqlite", "FOR UPDATE/SHARE")
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
      throw new UnsupportedDialectFeatureError("sqlite", "LATERAL JOIN")
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
    return super.printDelete(node)
  }

  /** SQLite has no `ARRAY[...]` literal syntax. */
  protected override printArrayExpr(_node: ArrayExprNode): string {
    throw new UnsupportedDialectFeatureError(
      "sqlite",
      "ARRAY[...] literal (SQLite has no array literal — use JSON arrays or raw SQL)",
    )
  }

  /** SQLite does not implement ANSI `MERGE`; use INSERT ... ON CONFLICT DO UPDATE. */
  protected override printMerge(_node: import("../ast/nodes.ts").MergeNode): string {
    throw new UnsupportedDialectFeatureError(
      "sqlite",
      "MERGE INTO (use INSERT ... ON CONFLICT DO UPDATE on SQLite)",
    )
  }

  /**
   * SQLite supports `->` / `->>` (3.38+) but has no path operators
   * `#>` / `#>>`; those are PG-specific. Reject with a pointer at
   * json_extract / chained `->`.
   */
  protected override printJsonAccess(node: import("../ast/nodes.ts").JsonAccessNode): string {
    if (node.operator === "#>" || node.operator === "#>>") {
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        `${node.operator} JSON path operator — use json_extract(expr, '$.a.b') or chained '->' on SQLite`,
      )
    }
    return super.printJsonAccess(node)
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
