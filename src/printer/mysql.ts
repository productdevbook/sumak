import type { InsertNode, SelectNode } from "../ast/nodes.ts";
import { UnsupportedDialectFeatureError } from "../errors.ts";
import { BasePrinter } from "./base.ts";

export class MysqlPrinter extends BasePrinter {
  constructor() {
    super("mysql");
  }

  protected override printInsert(node: InsertNode): string {
    if (node.returning.length > 0) {
      throw new UnsupportedDialectFeatureError("mysql", "RETURNING");
    }
    return super.printInsert(node);
  }

  protected override printSelect(node: SelectNode): string {
    if (node.forUpdate) {
      // MySQL supports FOR UPDATE, handled in base
    }
    return super.printSelect(node);
  }
}
