import type { FullTextSearchNode, InsertNode, JoinNode, SelectNode } from "../ast/nodes.ts"
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
