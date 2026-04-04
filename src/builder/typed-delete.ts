import { star } from "../ast/expression.ts"
import type { DeleteNode, ExpressionNode, SelectNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { SelectRow } from "../schema/types.ts"
import type { CompiledQuery } from "../types.ts"
import { DeleteBuilder } from "./delete.ts"
import type { WhereCallback } from "./eb.ts"
import { createColumnProxies, resetParams } from "./eb.ts"

/**
 * Type-safe DELETE query builder.
 */
export class TypedDeleteBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _builder: DeleteBuilder

  constructor(table: TB & string) {
    this._builder = new DeleteBuilder().from(table)
  }

  /** @internal */
  private _with(builder: DeleteBuilder): TypedDeleteBuilder<DB, TB> {
    const t = new TypedDeleteBuilder<DB, TB>("" as TB & string)
    ;(t as any)._builder = builder
    return t
  }

  /**
   * WHERE — callback or raw Expression.
   */
  where(exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>): TypedDeleteBuilder<DB, TB> {
    if (typeof exprOrCallback === "function") {
      resetParams()
      const table = this._builder.build().table.name as TB & string
      const cols = createColumnProxies<DB, TB>(table)
      const result = exprOrCallback(cols)
      return this._with(this._builder.where(unwrap(result)))
    }
    return this._with(this._builder.where(unwrap(exprOrCallback)))
  }

  /** USING clause (PG: DELETE FROM t USING other WHERE ...) */
  using<T extends keyof DB & string>(table: T): TypedDeleteBuilder<DB, TB> {
    return this._with(this._builder.using(table))
  }

  /** INNER JOIN for DELETE (MySQL pattern) */
  innerJoin(table: string, on: Expression<boolean>): TypedDeleteBuilder<DB, TB> {
    return this._with(this._builder.innerJoin(table, unwrap(on)))
  }

  /** LEFT JOIN for DELETE */
  leftJoin(table: string, on: Expression<boolean>): TypedDeleteBuilder<DB, TB> {
    return this._with(this._builder.leftJoin(table, unwrap(on)))
  }

  /**
   * RETURNING specific columns.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedDeleteReturningBuilder<DB, TB, Pick<SelectRow<DB, TB>, K>> {
    const exprs: ExpressionNode[] = cols.map((c) => ({ type: "column_ref" as const, column: c }))
    return new TypedDeleteReturningBuilder(
      new DeleteBuilder({
        ...this._builder.build(),
        returning: exprs,
      }),
    )
  }

  /**
   * RETURNING all columns.
   */
  returningAll(): TypedDeleteReturningBuilder<DB, TB, SelectRow<DB, TB>> {
    return new TypedDeleteReturningBuilder(
      new DeleteBuilder({
        ...this._builder.build(),
        returning: [star()],
      }),
    )
  }

  /** WITH (CTE) */
  with(name: string, query: SelectNode, recursive = false): TypedDeleteBuilder<DB, TB> {
    return this._with(this._builder.with(name, query, recursive))
  }

  /** Conditionally apply a transformation. */
  $if(
    condition: boolean,
    fn: (qb: TypedDeleteBuilder<DB, TB>) => TypedDeleteBuilder<DB, TB>,
  ): TypedDeleteBuilder<DB, TB> {
    if (condition) {
      return fn(this)
    }
    return this
  }

  build(): DeleteNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
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

export class TypedDeleteReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: DeleteBuilder

  constructor(builder: DeleteBuilder) {
    this._builder = builder
  }

  build(): DeleteNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }
}
