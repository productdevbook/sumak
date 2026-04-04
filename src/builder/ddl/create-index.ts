import type { CreateIndexNode } from "../../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../../ast/nodes.ts"

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

  where(expr: ExpressionNode): CreateIndexBuilder {
    return new CreateIndexBuilder({ ...this.node, where: expr })
  }

  build(): CreateIndexNode {
    return { ...this.node }
  }
}

export function createIndex(name: string): CreateIndexBuilder {
  return new CreateIndexBuilder(name)
}
