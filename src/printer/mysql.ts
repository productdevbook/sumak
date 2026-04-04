import type { FullTextSearchNode, InsertNode, SelectNode } from "../ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { quoteIdentifier } from "../utils/identifier.ts"
import { BasePrinter } from "./base.ts"

export class MysqlPrinter extends BasePrinter {
  constructor() {
    super("mysql")
  }

  protected override printInsert(node: InsertNode): string {
    if (node.returning.length > 0) {
      throw new UnsupportedDialectFeatureError("mysql", "RETURNING")
    }
    if (node.onConflict) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "ON CONFLICT (use onDuplicateKeyUpdate for MySQL)",
      )
    }

    let sql = super.printInsert(node)

    if (node.onDuplicateKeyUpdate && node.onDuplicateKeyUpdate.length > 0) {
      const sets = node.onDuplicateKeyUpdate
        .map((s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`)
        .join(", ")
      sql += ` ON DUPLICATE KEY UPDATE ${sets}`
    }

    return sql
  }

  protected override printSelect(node: SelectNode): string {
    // MySQL supports FOR UPDATE and FOR SHARE (handled in base)
    return super.printSelect(node)
  }

  protected override printFullTextSearch(node: FullTextSearchNode): string {
    const cols = node.columns.map((c) => this.printExpression(c)).join(", ")
    const query = this.printExpression(node.query)
    let mode = ""
    if (node.mode === "boolean") mode = " IN BOOLEAN MODE"
    else if (node.mode === "expansion") mode = " WITH QUERY EXPANSION"
    else if (node.mode === "natural") mode = " IN NATURAL LANGUAGE MODE"
    let result = `MATCH(${cols}) AGAINST(${query}${mode})`
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }
}
