import type { DropIndexNode, DropTableNode, DropViewNode } from "../../ast/ddl-nodes.ts"
import type { TableRefNode } from "../../ast/nodes.ts"

// ── DROP TABLE ──

export class DropTableBuilder {
  private readonly node: DropTableNode

  constructor(table: string, schema?: string) {
    const ref: TableRefNode = { type: "table_ref", name: table, schema }
    this.node = { type: "drop_table", table: ref }
  }

  private clone(patch: Partial<DropTableNode>): DropTableBuilder {
    const next = new DropTableBuilder(this.node.table.name, this.node.table.schema)
    return Object.assign(next, { node: { ...this.node, ...patch } }) as DropTableBuilder
  }

  ifExists(): DropTableBuilder {
    return this.clone({ ifExists: true })
  }

  cascade(): DropTableBuilder {
    return this.clone({ cascade: true })
  }

  build(): DropTableNode {
    return { ...this.node, table: { ...this.node.table } }
  }
}

// ── DROP INDEX ──

export class DropIndexBuilder {
  private readonly node: DropIndexNode

  constructor(name: string) {
    this.node = { type: "drop_index", name }
  }

  private clone(patch: Partial<DropIndexNode>): DropIndexBuilder {
    const next = new DropIndexBuilder(this.node.name)
    return Object.assign(next, { node: { ...this.node, ...patch } }) as DropIndexBuilder
  }

  on(table: string): DropIndexBuilder {
    return this.clone({ table })
  }

  ifExists(): DropIndexBuilder {
    return this.clone({ ifExists: true })
  }

  cascade(): DropIndexBuilder {
    return this.clone({ cascade: true })
  }

  build(): DropIndexNode {
    return { ...this.node }
  }
}

// ── DROP VIEW ──

export class DropViewBuilder {
  private readonly node: DropViewNode

  constructor(name: string) {
    this.node = { type: "drop_view", name }
  }

  private clone(patch: Partial<DropViewNode>): DropViewBuilder {
    const next = new DropViewBuilder(this.node.name)
    return Object.assign(next, { node: { ...this.node, ...patch } }) as DropViewBuilder
  }

  ifExists(): DropViewBuilder {
    return this.clone({ ifExists: true })
  }

  cascade(): DropViewBuilder {
    return this.clone({ cascade: true })
  }

  materialized(): DropViewBuilder {
    return this.clone({ materialized: true })
  }

  build(): DropViewNode {
    return { ...this.node }
  }
}

// ── Factory functions ──

export function dropTable(table: string, schema?: string): DropTableBuilder {
  return new DropTableBuilder(table, schema)
}

export function dropIndex(name: string): DropIndexBuilder {
  return new DropIndexBuilder(name)
}

export function dropView(name: string): DropViewBuilder {
  return new DropViewBuilder(name)
}
