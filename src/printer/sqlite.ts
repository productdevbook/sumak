import type { InsertNode, SelectNode } from "../ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { BasePrinter } from "./base.ts"

export class SqlitePrinter extends BasePrinter {
  constructor() {
    super("sqlite")
  }

  protected override printSelect(node: SelectNode): string {
    if (node.forUpdate) {
      throw new UnsupportedDialectFeatureError("sqlite", "FOR UPDATE")
    }
    return super.printSelect(node)
  }

  protected override printInsert(node: InsertNode): string {
    return super.printInsert(node)
  }
}
