import type { FullTextSearchNode, InsertNode, SelectNode } from "../ast/nodes.ts"
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
