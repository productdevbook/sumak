import type {
  ASTNode,
  SelectNode,
  InsertNode,
  UpdateNode,
  DeleteNode,
  TableRefNode,
} from "../ast/nodes.ts";
import type { PamukPlugin } from "./types.ts";

/**
 * Plugin that prepends a schema name to all table references.
 *
 * ```ts
 * const plugin = new WithSchemaPlugin("public");
 * // SELECT * FROM "users" → SELECT * FROM "public"."users"
 * ```
 */
export class WithSchemaPlugin implements PamukPlugin {
  readonly name = "with-schema";
  private schema: string;

  constructor(schema: string) {
    this.schema = schema;
  }

  transformNode(node: ASTNode): ASTNode {
    switch (node.type) {
      case "select":
        return this.transformSelect(node);
      case "insert":
        return this.transformInsert(node);
      case "update":
        return this.transformUpdate(node);
      case "delete":
        return this.transformDelete(node);
      default:
        return node;
    }
  }

  private addSchema(ref: TableRefNode): TableRefNode {
    if (ref.schema) return ref;
    return { ...ref, schema: this.schema };
  }

  private transformSelect(node: SelectNode): SelectNode {
    return {
      ...node,
      from: node.from
        ? node.from.type === "table_ref"
          ? this.addSchema(node.from)
          : node.from
        : undefined,
      joins: node.joins.map((j) => ({
        ...j,
        table: j.table.type === "table_ref" ? this.addSchema(j.table) : j.table,
      })),
    };
  }

  private transformInsert(node: InsertNode): InsertNode {
    return { ...node, table: this.addSchema(node.table) };
  }

  private transformUpdate(node: UpdateNode): UpdateNode {
    return {
      ...node,
      table: this.addSchema(node.table),
      from: node.from ? this.addSchema(node.from) : undefined,
    };
  }

  private transformDelete(node: DeleteNode): DeleteNode {
    return { ...node, table: this.addSchema(node.table) };
  }
}
