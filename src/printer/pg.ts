import type { InsertNode } from "../ast/nodes.ts"
import { BasePrinter } from "./base.ts"

export class PgPrinter extends BasePrinter {
  constructor() {
    super("pg")
  }

  protected override printInsert(node: InsertNode): string {
    return super.printInsert(node)
  }
}
