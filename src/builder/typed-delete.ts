import { star } from "../ast/expression.ts"
import type { ASTNode, DeleteNode, ExplainNode, ExpressionNode, SelectNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { SelectRow } from "../schema/types.ts"
import type { CompiledQuery } from "../types.ts"
import type { CompiledQueryFn } from "./compiled.ts"
import { compileQuery } from "./compiled.ts"
import { DeleteBuilder } from "./delete.ts"
import type { WhereCallback } from "./eb.ts"
import { createColumnProxies } from "./eb.ts"
import { ExplainBuilder } from "./explain.ts"

/**
 * Type-safe DELETE query builder.
 */
export class TypedDeleteBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _builder: DeleteBuilder
  /** @internal */
  readonly _printer?: Printer
  /** @internal */
  readonly _compile?: (node: ASTNode) => CompiledQuery

  constructor(
    table: TB & string,
    printer?: Printer,
    compile?: (node: ASTNode) => CompiledQuery,
    builder?: DeleteBuilder,
  ) {
    this._builder = builder ?? new DeleteBuilder().from(table)
    this._printer = printer
    this._compile = compile
  }

  /** @internal */
  private _with(builder: DeleteBuilder): TypedDeleteBuilder<DB, TB> {
    return new TypedDeleteBuilder<DB, TB>("" as TB & string, this._printer, this._compile, builder)
  }

  /**
   * WHERE — callback or raw Expression.
   */
  where(exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>): TypedDeleteBuilder<DB, TB> {
    if (typeof exprOrCallback === "function") {
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
   * RETURNING columns or aliased expressions.
   *
   * ```ts
   * db.deleteFrom("users").where(...).returning("id", "name")
   * db.deleteFrom("users").where(...).returning({ deletedId: col("id") })
   * ```
   *
   * Accumulates across chained calls — use `.returningAll()` to reset.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedDeleteReturningBuilder<DB, TB, Pick<SelectRow<DB, TB>, K>>
  returning<A extends Record<string, Expression<any>>>(
    aliased: A,
  ): TypedDeleteReturningBuilder<
    DB,
    TB,
    SelectRow<DB, TB> & { [K in keyof A]: A[K] extends Expression<infer T> ? T : never }
  >
  returning(...args: unknown[]): any {
    if (args.length === 0) {
      throw new Error(".returning() requires at least one column or expression.")
    }
    if (
      args.length === 1 &&
      typeof args[0] === "object" &&
      args[0] !== null &&
      !Array.isArray(args[0]) &&
      Object.keys(args[0] as object).length === 0
    ) {
      throw new Error(".returning({}) requires at least one aliased expression.")
    }
    const existing = this._builder.build().returning
    let exprs: ExpressionNode[]
    if (
      args.length === 1 &&
      typeof args[0] === "object" &&
      args[0] !== null &&
      !Array.isArray(args[0])
    ) {
      exprs = Object.entries(args[0] as Record<string, Expression<any>>).map(([alias, expr]) => ({
        type: "aliased_expr" as const,
        expr: unwrap(expr as Expression<any>),
        alias,
      }))
    } else {
      exprs = (args as string[]).map((c) => ({ type: "column_ref" as const, column: c }))
    }
    return new TypedDeleteReturningBuilder(
      new DeleteBuilder({
        ...this._builder.build(),
        returning: [...existing, ...exprs],
      }),
      this._printer,
      this._compile,
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
      this._printer,
      this._compile,
    )
  }

  /** WITH (CTE) */
  with(
    name: string,
    query: SelectNode,
    options?: { recursive?: boolean },
  ): TypedDeleteBuilder<DB, TB> {
    return this._with(this._builder.with(name, query, options?.recursive === true))
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

  /** Compile to SQL using the dialect's printer. */
  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this.build())
    if (!this._printer) {
      throw new Error(
        "toSQL() requires a printer. Use db.deleteFrom() or pass a printer to compile().",
      )
    }
    return this._printer.print(this.build())
  }

  /** EXPLAIN — returns a chainable ExplainBuilder. */
  explain(options?: {
    analyze?: boolean
    format?: "TEXT" | "JSON" | "YAML" | "XML"
  }): ExplainBuilder {
    const explainNode: ExplainNode = {
      type: "explain",
      statement: this.build(),
      analyze: options?.analyze,
      format: options?.format,
    }
    return new ExplainBuilder(explainNode, this._printer, this._compile)
  }

  /** Pre-compile the SQL with placeholders. See `TypedSelectBuilder.toCompiled()`. */
  toCompiled<P extends Record<string, unknown> = Record<string, unknown>>(): CompiledQueryFn<P> {
    if (!this._printer) {
      throw new Error(
        "toCompiled() requires a printer. Use db.deleteFrom() to construct the builder.",
      )
    }
    return compileQuery<P>(this.build(), this._printer, this._compile)
  }
}

export class TypedDeleteReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: DeleteBuilder
  /** @internal */
  readonly _printer?: Printer
  /** @internal */
  readonly _compile?: (node: ASTNode) => CompiledQuery

  constructor(
    builder: DeleteBuilder,
    printer?: Printer,
    compile?: (node: ASTNode) => CompiledQuery,
  ) {
    this._builder = builder
    this._printer = printer
    this._compile = compile
  }

  build(): DeleteNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Run through the full compile pipeline (plugins, hooks, normalize, optimize, print). */
  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this.build())
    if (!this._printer) {
      throw new Error("toSQL() requires a printer. Use db.deleteFrom() to construct the builder.")
    }
    return this._printer.print(this.build())
  }
}
