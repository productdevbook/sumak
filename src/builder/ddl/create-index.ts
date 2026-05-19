import type { CreateIndexNode } from "../../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../../ast/nodes.ts"
import type { Expression } from "../../ast/typed-expression.ts"

export class CreateIndexBuilder {
  private readonly node: CreateIndexNode

  constructor(name: string)
  constructor(node: CreateIndexNode)
  constructor(nameOrNode: string | CreateIndexNode) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "create_index",
        name: nameOrNode,
        table: "",
        columns: [],
      }
    } else {
      this.node = nameOrNode
    }
  }

  on(table: string): CreateIndexBuilder {
    return new CreateIndexBuilder({ ...this.node, table })
  }

  column(col: string, direction?: "ASC" | "DESC"): CreateIndexBuilder {
    return new CreateIndexBuilder({
      ...this.node,
      columns: [...this.node.columns, { column: col, direction }],
    })
  }

  columns(cols: (string | { column: string; direction?: "ASC" | "DESC" })[]): CreateIndexBuilder {
    const normalized = cols.map((c) => (typeof c === "string" ? { column: c } : c))
    return new CreateIndexBuilder({
      ...this.node,
      columns: [...this.node.columns, ...normalized],
    })
  }

  unique(): CreateIndexBuilder {
    return new CreateIndexBuilder({ ...this.node, unique: true })
  }

  ifNotExists(): CreateIndexBuilder {
    return new CreateIndexBuilder({ ...this.node, ifNotExists: true })
  }

  using(method: string): CreateIndexBuilder {
    return new CreateIndexBuilder({ ...this.node, using: method })
  }

  /**
   * Add a partial index predicate (`CREATE INDEX … WHERE <expr>`). The
   * predicate is part of the index's identity — schemas where two
   * indexes share a name but differ in their WHERE clause are treated
   * as a drop + recreate by the diff engine.
   *
   * Accepts either a raw AST node (used by internal diff lowering and
   * by tests that pre-build `{ type: "raw", sql, params: [] }`) or a
   * sumak `Expression<boolean>` — the wrapper returned by `sql\`...\``
   * and `eb({...}) => ...` callbacks. The latter is unwrapped to its
   * underlying AST node.
   *
   * Partial indexes are supported on PG and SQLite; the DDL printer
   * throws `UnsupportedDialectFeatureError` on MySQL and MSSQL.
   */
  where(expr: ExpressionNode | Expression<boolean>): CreateIndexBuilder {
    // Expression<boolean> is shaped `{ node: ExpressionNode, ... }`;
    // ExpressionNode is shaped `{ type: "...", ... }`. The discriminator
    // is the presence of a `.node` field whose value is itself a node.
    const maybeWrapper = expr as { node?: ExpressionNode }
    const node = maybeWrapper.node ?? (expr as ExpressionNode)
    return new CreateIndexBuilder({ ...this.node, where: node })
  }

  build(): CreateIndexNode {
    return { ...this.node }
  }
}

export function createIndex(name: string): CreateIndexBuilder {
  return new CreateIndexBuilder(name)
}
