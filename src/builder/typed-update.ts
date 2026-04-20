import { param, star } from "../ast/expression.ts"
import type { ExpressionNode, SelectNode, UpdateNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { isExpression, unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { SelectRow, Updateable } from "../schema/types.ts"
import type { CompiledQuery } from "../types.ts"
import type { WhereCallback } from "./eb.ts"
import { createColumnProxies } from "./eb.ts"
import { ExplainBuilder } from "./explain.ts"
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
   * SET columns. Accepts either raw values (auto-parameterized) or
   * Expression<T> — mix them freely in a single object:
   *
   * ```ts
   * db.update("users").set({
   *   name: "Alice",                           // value → $1
   *   updated_at: fn("CURRENT_TIMESTAMP", []),  // expression → inline SQL
   * })
   * ```
   */
  set(values: {
    [K in keyof Updateable<DB[TB]>]?: Updateable<DB[TB]>[K] | Expression<any>
  }): TypedUpdateBuilder<DB, TB> {
    let builder = this._builder
    const entries = Object.entries(values as Record<string, unknown>)
    for (const [col, val] of entries) {
      if (val === undefined) continue
      // `isExpression` uses a hidden symbol brand — cannot be confused
      // with a JSON column value that happens to have a `node` key.
      if (isExpression(val)) {
        builder = builder.set(col, unwrap(val as Expression<any>))
      } else {
        builder = builder.set(col, param(0, val))
      }
    }
    if (entries.filter(([, v]) => v !== undefined).length === 0) {
      throw new Error(
        ".set() requires at least one column — an empty object would produce invalid SQL.",
      )
    }
    return this._with(builder)
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
   * RETURNING columns or aliased expressions.
   *
   * ```ts
   * db.update("users").set(...).where(...).returning("id", "name")
   * db.update("users").set(...).where(...).returning({ newName: col("name") })
   * ```
   *
   * Accumulates across chained calls — use `.returningAll()` to reset.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedUpdateReturningBuilder<DB, TB, Pick<SelectRow<DB, TB>, K>>
  returning<A extends Record<string, Expression<any>>>(
    aliased: A,
  ): TypedUpdateReturningBuilder<
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
    return new TypedUpdateReturningBuilder(
      new UpdateBuilder({
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
  returningAll(): TypedUpdateReturningBuilder<DB, TB, SelectRow<DB, TB>> {
    return new TypedUpdateReturningBuilder(
      new UpdateBuilder({
        ...this._builder.build(),
        returning: [star()],
      }),
      this._printer,
      this._compile,
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
  with(
    name: string,
    query: SelectNode,
    options?: { recursive?: boolean },
  ): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.with(name, query, options?.recursive === true))
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

  /** EXPLAIN — returns a chainable ExplainBuilder. */
  explain(options?: {
    analyze?: boolean
    format?: "TEXT" | "JSON" | "YAML" | "XML"
  }): ExplainBuilder {
    const explainNode: import("../ast/nodes.ts").ExplainNode = {
      type: "explain",
      statement: this.build(),
      analyze: options?.analyze,
      format: options?.format,
    }
    return new ExplainBuilder(explainNode, this._printer, this._compile)
  }
}

export class TypedUpdateReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: UpdateBuilder
  /** @internal */
  _printer?: Printer
  /** @internal */
  _compile?: (node: import("../ast/nodes.ts").ASTNode) => CompiledQuery

  constructor(
    builder: UpdateBuilder,
    printer?: Printer,
    compile?: (node: import("../ast/nodes.ts").ASTNode) => CompiledQuery,
  ) {
    this._builder = builder
    this._printer = printer
    this._compile = compile
  }

  build(): UpdateNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Run through the full compile pipeline (plugins, hooks, normalize, optimize, print). */
  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this.build())
    if (!this._printer) {
      throw new Error("toSQL() requires a printer. Use db.update() to construct the builder.")
    }
    return this._printer.print(this.build())
  }
}
