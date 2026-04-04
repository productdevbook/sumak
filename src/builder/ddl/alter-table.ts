import type {
  AlterColumnSet,
  AlterTableAction,
  AlterTableNode,
  ColumnDefinitionNode,
  ForeignKeyAction,
  ForeignKeyConstraintNode,
  PrimaryKeyConstraintNode,
  UniqueConstraintNode,
} from "../../ast/ddl-nodes.ts"
import type { TableRefNode } from "../../ast/nodes.ts"
import { ColumnDefBuilder } from "./create-table.ts"

export class AlterTableBuilder {
  private readonly node: AlterTableNode

  constructor(table: string, schema?: string) {
    const ref: TableRefNode = { type: "table_ref", name: table, schema }
    this.node = { type: "alter_table", table: ref, actions: [] }
  }

  private withAction(action: AlterTableAction): AlterTableBuilder {
    const next = new AlterTableBuilder(this.node.table.name, this.node.table.schema)
    return Object.assign(next, {
      node: { ...this.node, actions: [...this.node.actions, action] },
    }) as AlterTableBuilder
  }

  addColumn(
    name: string,
    dataType: string,
    build?: (col: ColumnDefBuilder) => ColumnDefBuilder,
  ): AlterTableBuilder {
    let colBuilder = new ColumnDefBuilder(name, dataType)
    if (build) {
      colBuilder = build(colBuilder)
    }
    const colDef = colBuilder._build()
    return this.withAction({ kind: "add_column", column: colDef })
  }

  dropColumn(name: string): AlterTableBuilder {
    return this.withAction({ kind: "drop_column", column: name })
  }

  renameColumn(from: string, to: string): AlterTableBuilder {
    return this.withAction({ kind: "rename_column", from, to })
  }

  renameTo(newName: string): AlterTableBuilder {
    return this.withAction({ kind: "rename_table", to: newName })
  }

  alterColumn(column: string, set: AlterColumnSet): AlterTableBuilder {
    return this.withAction({ kind: "alter_column", column, set })
  }

  addPrimaryKeyConstraint(name: string | undefined, columns: string[]): AlterTableBuilder {
    const constraint: PrimaryKeyConstraintNode = {
      type: "pk_constraint",
      name,
      columns,
    }
    return this.withAction({ kind: "add_constraint", constraint })
  }

  addUniqueConstraint(name: string | undefined, columns: string[]): AlterTableBuilder {
    const constraint: UniqueConstraintNode = {
      type: "unique_constraint",
      name,
      columns,
    }
    return this.withAction({ kind: "add_constraint", constraint })
  }

  addForeignKeyConstraint(
    name: string | undefined,
    columns: string[],
    refTable: string,
    refColumns: string[],
    build?: (fk: ForeignKeyConstraintBuilder) => ForeignKeyConstraintBuilder,
  ): AlterTableBuilder {
    let constraint: ForeignKeyConstraintNode = {
      type: "fk_constraint",
      name,
      columns,
      references: { table: refTable, columns: refColumns },
    }
    if (build) {
      const builder = build(new ForeignKeyConstraintBuilder(constraint))
      constraint = builder.build()
    }
    return this.withAction({ kind: "add_constraint", constraint })
  }

  dropConstraint(name: string): AlterTableBuilder {
    return this.withAction({ kind: "drop_constraint", name })
  }

  build(): AlterTableNode {
    return { ...this.node, actions: [...this.node.actions] }
  }
}

export class ForeignKeyConstraintBuilder {
  private readonly node: ForeignKeyConstraintNode

  constructor(node: ForeignKeyConstraintNode) {
    this.node = node
  }

  onDelete(action: ForeignKeyAction): ForeignKeyConstraintBuilder {
    return new ForeignKeyConstraintBuilder({
      ...this.node,
      references: { ...this.node.references, onDelete: action },
    })
  }

  onUpdate(action: ForeignKeyAction): ForeignKeyConstraintBuilder {
    return new ForeignKeyConstraintBuilder({
      ...this.node,
      references: { ...this.node.references, onUpdate: action },
    })
  }

  build(): ForeignKeyConstraintNode {
    return { ...this.node, references: { ...this.node.references } }
  }
}

export function alterTable(table: string, schema?: string): AlterTableBuilder {
  return new AlterTableBuilder(table, schema)
}
