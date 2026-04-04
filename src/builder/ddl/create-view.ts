import type { CreateViewNode } from "../../ast/ddl-nodes.ts"
import type { SelectNode } from "../../ast/nodes.ts"

export class CreateViewBuilder {
  private readonly node: CreateViewNode

  constructor(name: string, schema?: string)
  constructor(node: CreateViewNode)
  constructor(nameOrNode: string | CreateViewNode, schema?: string) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "create_view",
        name: nameOrNode,
        schema,
        asSelect: undefined as unknown as SelectNode,
      }
    } else {
      this.node = nameOrNode
    }
  }

  orReplace(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, orReplace: true })
  }

  temporary(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, temporary: true })
  }

  materialized(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, materialized: true })
  }

  ifNotExists(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, ifNotExists: true })
  }

  columns(...cols: string[]): CreateViewBuilder {
    return new CreateViewBuilder({
      ...this.node,
      columns: [...(this.node.columns ?? []), ...cols],
    })
  }

  asSelect(query: SelectNode): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, asSelect: query })
  }

  build(): CreateViewNode {
    return { ...this.node }
  }
}

export function createView(name: string, schema?: string): CreateViewBuilder {
  return new CreateViewBuilder(name, schema)
}
