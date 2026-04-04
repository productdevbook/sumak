import type {
  ColumnDefinitionNode,
  CreateTableNode,
  ForeignKeyAction,
  TableConstraintNode,
} from "../../ast/ddl-nodes.ts"
import type { ExpressionNode, SelectNode, TableRefNode } from "../../ast/nodes.ts"

// ── ForeignKeyBuilder ──

export class ForeignKeyBuilder {
  private _onDelete?: ForeignKeyAction
  private _onUpdate?: ForeignKeyAction

  constructor(onDelete?: ForeignKeyAction, onUpdate?: ForeignKeyAction) {
    this._onDelete = onDelete
    this._onUpdate = onUpdate
  }

  onDelete(action: ForeignKeyAction): ForeignKeyBuilder {
    return new ForeignKeyBuilder(action, this._onUpdate)
  }

  onUpdate(action: ForeignKeyAction): ForeignKeyBuilder {
    return new ForeignKeyBuilder(this._onDelete, action)
  }

  /** @internal */
  _getOnDelete(): ForeignKeyAction | undefined {
    return this._onDelete
  }

  /** @internal */
  _getOnUpdate(): ForeignKeyAction | undefined {
    return this._onUpdate
  }
}

// ── ColumnDefBuilder ──

export class ColumnDefBuilder {
  private node: ColumnDefinitionNode

  constructor(name: string, dataType: string) {
    this.node = { type: "column_definition", name, dataType }
  }

  private clone(patch: Partial<ColumnDefinitionNode>): ColumnDefBuilder {
    const builder = new ColumnDefBuilder(this.node.name, this.node.dataType)
    builder.node = { ...this.node, ...patch }
    return builder
  }

  notNull(): ColumnDefBuilder {
    return this.clone({ notNull: true })
  }

  defaultTo(value: ExpressionNode): ColumnDefBuilder {
    return this.clone({ defaultTo: value })
  }

  primaryKey(): ColumnDefBuilder {
    return this.clone({ primaryKey: true })
  }

  unique(): ColumnDefBuilder {
    return this.clone({ unique: true })
  }

  check(expr: ExpressionNode): ColumnDefBuilder {
    return this.clone({ check: expr })
  }

  autoIncrement(): ColumnDefBuilder {
    return this.clone({ autoIncrement: true })
  }

  references(table: string, column: string): ColumnDefBuilder {
    return this.clone({
      references: {
        table,
        column,
        onDelete: this.node.references?.onDelete,
        onUpdate: this.node.references?.onUpdate,
      },
    })
  }

  onDelete(action: ForeignKeyAction): ColumnDefBuilder {
    return this.clone({
      references: this.node.references ? { ...this.node.references, onDelete: action } : undefined,
    })
  }

  onUpdate(action: ForeignKeyAction): ColumnDefBuilder {
    return this.clone({
      references: this.node.references ? { ...this.node.references, onUpdate: action } : undefined,
    })
  }

  generatedAlwaysAs(expr: ExpressionNode): ColumnDefBuilder {
    return this.clone({
      generatedAs: { expression: expr, stored: this.node.generatedAs?.stored },
    })
  }

  stored(): ColumnDefBuilder {
    return this.clone({
      generatedAs: this.node.generatedAs ? { ...this.node.generatedAs, stored: true } : undefined,
    })
  }

  /** @internal */
  _build(): ColumnDefinitionNode {
    return { ...this.node }
  }
}

// ── CreateTableBuilder ──

export class CreateTableBuilder {
  private node: CreateTableNode

  constructor(table: string, schema?: string) {
    const tableRef: TableRefNode = { type: "table_ref", name: table, schema }
    this.node = {
      type: "create_table",
      table: tableRef,
      columns: [],
      constraints: [],
    }
  }

  private cloneWith(patch: Partial<CreateTableNode>): CreateTableBuilder {
    const builder = Object.create(CreateTableBuilder.prototype) as CreateTableBuilder
    builder.node = { ...this.node, ...patch }
    return builder
  }

  ifNotExists(): CreateTableBuilder {
    return this.cloneWith({ ifNotExists: true })
  }

  temporary(): CreateTableBuilder {
    return this.cloneWith({ temporary: true })
  }

  addColumn(
    name: string,
    dataType: string,
    build?: (col: ColumnDefBuilder) => ColumnDefBuilder,
  ): CreateTableBuilder {
    let colBuilder = new ColumnDefBuilder(name, dataType)
    if (build) {
      colBuilder = build(colBuilder)
    }
    return this.cloneWith({
      columns: [...this.node.columns, colBuilder._build()],
    })
  }

  addPrimaryKeyConstraint(name: string | undefined, columns: string[]): CreateTableBuilder {
    const constraint: TableConstraintNode = {
      type: "pk_constraint",
      name,
      columns,
    }
    return this.cloneWith({
      constraints: [...this.node.constraints, constraint],
    })
  }

  addUniqueConstraint(name: string | undefined, columns: string[]): CreateTableBuilder {
    const constraint: TableConstraintNode = {
      type: "unique_constraint",
      name,
      columns,
    }
    return this.cloneWith({
      constraints: [...this.node.constraints, constraint],
    })
  }

  addCheckConstraint(name: string | undefined, expression: ExpressionNode): CreateTableBuilder {
    const constraint: TableConstraintNode = {
      type: "check_constraint",
      name,
      expression,
    }
    return this.cloneWith({
      constraints: [...this.node.constraints, constraint],
    })
  }

  addForeignKeyConstraint(
    name: string | undefined,
    columns: string[],
    refTable: string,
    refColumns: string[],
    build?: (fk: ForeignKeyBuilder) => ForeignKeyBuilder,
  ): CreateTableBuilder {
    let fkBuilder = new ForeignKeyBuilder()
    if (build) {
      fkBuilder = build(fkBuilder)
    }
    const constraint: TableConstraintNode = {
      type: "fk_constraint",
      name,
      columns,
      references: {
        table: refTable,
        columns: refColumns,
        onDelete: fkBuilder._getOnDelete(),
        onUpdate: fkBuilder._getOnUpdate(),
      },
    }
    return this.cloneWith({
      constraints: [...this.node.constraints, constraint],
    })
  }

  asSelect(query: SelectNode): CreateTableBuilder {
    return this.cloneWith({ asSelect: query })
  }

  build(): CreateTableNode {
    return { ...this.node }
  }
}

// ── Factory ──

export function createTable(table: string, schema?: string): CreateTableBuilder {
  return new CreateTableBuilder(table, schema)
}
