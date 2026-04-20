import { param, star } from "../ast/expression.ts"
import type { ExpressionNode, SelectNode, UpdateNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { SelectRow, Updateable } from "../schema/types.ts"
import type { CompiledQuery } from "../types.ts"
import type { WhereCallback } from "./eb.ts"
import { createColumnProxies } from "./eb.ts"
import { UpdateBuilder } from "./update.ts"

/**
 * Type-safe UPDATE query builder.
 */
export class TypedUpdateBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _builder: UpdateBuilder
  /** @internal */
  _printer?: Printer
  /** @internal */
  _compile?: (node: import("../ast/nodes.ts").ASTNode) => CompiledQuery

  constructor(table: TB & string) {
    this._builder = new UpdateBuilder().table(table)
  }

  /** @internal */
  private _with(builder: UpdateBuilder): TypedUpdateBuilder<DB, TB> {
    const t = new TypedUpdateBuilder<DB, TB>("" as TB & string)
    ;(t as any)._builder = builder
    ;(t as any)._printer = this._printer
    ;(t as any)._compile = this._compile
    return t
  }

  /**
   * Bypass the soft-delete filter for this UPDATE (include rows where
   * `deleted_at IS NOT NULL`). Useful for admin operations.
   * Last-call wins: `.onlyDeleted()` after this replaces the mode.
   */
  includeDeleted(): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.withSoftDeleteMode("include"))
  }

  /**
   * Target ONLY soft-deleted rows (`deleted_at IS NOT NULL`).
   * Last-call wins: `.includeDeleted()` after this replaces the mode.
   */
  onlyDeleted(): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.withSoftDeleteMode("only"))
  }

  /**
   * SET columns from an object. All keys optional (Updateable).
   */
  set(values: Updateable<DB[TB]>): TypedUpdateBuilder<DB, TB> {
    let builder = this._builder
    for (const [col, val] of Object.entries(values as Record<string, unknown>)) {
      if (val !== undefined) {
        builder = builder.set(col, param(0, val))
      }
    }
    return this._with(builder)
  }

  /**
   * SET a single column with an expression.
   */
  setExpr(column: keyof DB[TB] & string, value: Expression<any>): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.set(column, unwrap(value)))
  }

  /**
   * WHERE — callback or raw Expression.
   */
  where(exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>): TypedUpdateBuilder<DB, TB> {
    if (typeof exprOrCallback === "function") {
      const cols = createColumnProxies<DB, TB>(this._table)
      const result = exprOrCallback(cols)
      return this._with(this._builder.where(unwrap(result)))
    }
    return this._with(this._builder.where(unwrap(exprOrCallback)))
  }

  private get _table(): TB & string {
    return this._builder.build().table.name as TB & string
  }

  /**
   * RETURNING specific columns.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedUpdateReturningBuilder<DB, TB, Pick<SelectRow<DB, TB>, K>> {
    const exprs: ExpressionNode[] = cols.map((c) => ({ type: "column_ref" as const, column: c }))
    return new TypedUpdateReturningBuilder(
      new UpdateBuilder({
        ...this._builder.build(),
        returning: exprs,
      }),
    )
  }

  /**
   * RETURNING all columns.
   */
  returningAll(): TypedUpdateReturningBuilder<DB, TB, SelectRow<DB, TB>> {
    return new TypedUpdateReturningBuilder(
      new UpdateBuilder({
        ...this._builder.build(),
        returning: [star()],
      }),
    )
  }

  /** INNER JOIN for UPDATE (MySQL pattern) */
  innerJoin(table: string, on: Expression<boolean>): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.innerJoin(table, unwrap(on)))
  }

  /** LEFT JOIN for UPDATE */
  leftJoin(table: string, on: Expression<boolean>): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.leftJoin(table, unwrap(on)))
  }

  /** FROM clause (for UPDATE ... FROM ... WHERE joins). */
  from<T extends keyof DB & string>(table: T): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.from(table))
  }

  /** WITH (CTE) */
  with(name: string, query: SelectNode, recursive = false): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.with(name, query, recursive))
  }

  /** Conditionally apply a transformation. */
  $if(
    condition: boolean,
    fn: (qb: TypedUpdateBuilder<DB, TB>) => TypedUpdateBuilder<DB, TB>,
  ): TypedUpdateBuilder<DB, TB> {
    if (condition) {
      return fn(this)
    }
    return this
  }

  build(): UpdateNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Compile to SQL using the dialect's printer. */
  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this.build())
    if (!this._printer) {
      throw new Error("toSQL() requires a printer. Use db.update() or pass a printer to compile().")
    }
    return this._printer.print(this.build())
  }

  /** EXPLAIN this query. */
  explain(options?: { analyze?: boolean; format?: "TEXT" | "JSON" | "YAML" | "XML" }): {
    build(): import("../ast/nodes.ts").ExplainNode
    compile(printer: Printer): CompiledQuery
  } {
    const node = this.build()
    const explainNode: import("../ast/nodes.ts").ExplainNode = {
      type: "explain",
      statement: node,
      analyze: options?.analyze,
      format: options?.format,
    }
    return {
      build: () => explainNode,
      compile: (p: Printer) => p.print(explainNode),
    }
  }
}

export class TypedUpdateReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: UpdateBuilder

  constructor(builder: UpdateBuilder) {
    this._builder = builder
  }

  build(): UpdateNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }
}
