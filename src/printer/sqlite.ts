import type {
  BinaryOpNode,
  FullTextSearchNode,
  InsertNode,
  JoinNode,
  SelectNode,
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
    return super.printInsert(node)
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
