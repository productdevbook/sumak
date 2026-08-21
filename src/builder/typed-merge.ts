import { param, star } from "../ast/expression.ts"
import type { ASTNode, ExpressionNode, MergeNode, SelectNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { SumakExecutor } from "../driver/execute.ts"
import { listenerFor, resultTransformer, runExecute, runQuery } from "../driver/execute.ts"
import { deriveResultContext } from "../plugin/result-context.ts"
import type { Printer } from "../printer/types.ts"
import type { Insertable, SelectRow, Updateable } from "../schema/types.ts"
import type { CompiledQuery } from "../types.ts"
import type { CompiledQueryFn } from "./compiled.ts"
import { compileQuery } from "./compiled.ts"
import { Col } from "./eb.ts"
import { MergeBuilder } from "./merge.ts"
import { runnersFor } from "./runners.ts"

type MergeProxies<DB, Target extends keyof DB, Source extends keyof DB> = {
  target: { [K in keyof DB[Target] & string]: Col<any> }
  source: { [K in keyof DB[Source] & string]: Col<any> }
}

function createMergeProxies<DB, Target extends keyof DB, Source extends keyof DB>(
  targetTable: string,
  sourceAlias: string,
): MergeProxies<DB, Target, Source> {
  const makeProxy = (prefix: string) =>
    new Proxy(
      {},
      {
        get(_t: any, colName: string) {
          return new Col(colName, prefix)
        },
      },
    )

  return {
    target: makeProxy(targetTable) as any,
    source: makeProxy(sourceAlias) as any,
  }
}

export class TypedMergeBuilder<DB, Target extends keyof DB, Source extends keyof DB> {
  /** @internal */
  readonly _builder: MergeBuilder
  /** @internal */
  readonly _printer?: Printer
  /** @internal */
  readonly _compile?: (node: ASTNode) => CompiledQuery
  /** @internal */
  readonly _executor?: SumakExecutor
  private readonly _targetTable: Target & string
  private readonly _sourceAlias: string

  /**
   * Public constructor — called by `db.mergeInto(...)`. Callers pass the
   * target/source/alias/on and we build the underlying `MergeBuilder`.
   *
   * `existingBuilder` is an internal escape hatch used by the chainable
   * `.whenMatchedThenUpdate()` / `.with()` etc. methods to clone state
   * without constructing a fresh `MergeBuilder` over empty strings.
   */
  constructor(
    targetTable: Target & string,
    sourceTable: Source & string,
    sourceAlias: string,
    on: Expression<boolean>,
    printer?: Printer,
    compile?: (node: ASTNode) => CompiledQuery,
    /** @internal */
    existingBuilder?: MergeBuilder,
    /** @internal */
    executor?: SumakExecutor,
  ) {
    this._targetTable = targetTable
    this._sourceAlias = sourceAlias
    this._printer = printer
    this._compile = compile
    this._executor = executor
    this._builder =
      existingBuilder ??
      new MergeBuilder().into(targetTable).using(sourceTable, sourceAlias).on(unwrap(on))
  }

  /** @internal */
  private _with(builder: MergeBuilder): TypedMergeBuilder<DB, Target, Source> {
    return new TypedMergeBuilder<DB, Target, Source>(
      this._targetTable,
      "" as Source & string,
      this._sourceAlias,
      { node: { type: "literal", value: true } } as any,
      this._printer,
      this._compile,
      builder,
      this._executor,
    )
  }

  whenMatchedThenUpdate(
    values: Updateable<DB[Target]>,
    condition?: (proxies: MergeProxies<DB, Target, Source>) => Expression<boolean>,
  ): TypedMergeBuilder<DB, Target, Source> {
    const set: { column: string; value: ExpressionNode }[] = []
    for (const [col, val] of Object.entries(values as Record<string, unknown>)) {
      if (val !== undefined) {
        set.push({ column: col, value: param(0, val) })
      }
    }
    if (set.length === 0) {
      throw new Error(
        ".whenMatchedThenUpdate({}) requires at least one column — an empty object " +
          "would produce `WHEN MATCHED THEN UPDATE SET ` with no columns (invalid SQL).",
      )
    }
    let condExpr: ExpressionNode | undefined
    if (condition) {
      const proxies = createMergeProxies<DB, Target, Source>(this._targetTable, this._sourceAlias)
      condExpr = unwrap(condition(proxies))
    }
    return this._with(this._builder.whenMatchedUpdate(set, condExpr))
  }

  whenMatchedThenDelete(
    condition?: (proxies: MergeProxies<DB, Target, Source>) => Expression<boolean>,
  ): TypedMergeBuilder<DB, Target, Source> {
    let condExpr: ExpressionNode | undefined
    if (condition) {
      const proxies = createMergeProxies<DB, Target, Source>(this._targetTable, this._sourceAlias)
      condExpr = unwrap(condition(proxies))
    }
    return this._with(this._builder.whenMatchedDelete(condExpr))
  }

  whenNotMatchedThenInsert(
    row: Insertable<DB[Target]>,
    condition?: (proxies: MergeProxies<DB, Target, Source>) => Expression<boolean>,
  ): TypedMergeBuilder<DB, Target, Source> {
    const entries = Object.entries(row as Record<string, unknown>)
    const columns = entries.map(([k]) => k)
    const values = entries.map((entry) => param(0, entry[1]))
    let condExpr: ExpressionNode | undefined
    if (condition) {
      const proxies = createMergeProxies<DB, Target, Source>(this._targetTable, this._sourceAlias)
      condExpr = unwrap(condition(proxies))
    }
    return this._with(this._builder.whenNotMatchedInsert(columns, values, condExpr))
  }

  /**
   * `WHEN NOT MATCHED BY SOURCE THEN UPDATE SET …` — applies to target rows
   * that have no matching source row. Useful for full-sync MERGE patterns.
   *
   * Supported by PostgreSQL 17+ and SQL Server. MySQL and SQLite have no
   * `MERGE` at all and will throw at print time.
   */
  whenNotMatchedBySourceThenUpdate(
    values: Updateable<DB[Target]>,
    condition?: (proxies: MergeProxies<DB, Target, Source>) => Expression<boolean>,
  ): TypedMergeBuilder<DB, Target, Source> {
    const set: { column: string; value: ExpressionNode }[] = []
    for (const [col, val] of Object.entries(values as Record<string, unknown>)) {
      if (val !== undefined) {
        set.push({ column: col, value: param(0, val) })
      }
    }
    if (set.length === 0) {
      throw new Error(
        ".whenNotMatchedBySourceThenUpdate({}) requires at least one column — an empty " +
          "object would produce `WHEN NOT MATCHED BY SOURCE THEN UPDATE SET ` with no " +
          "columns (invalid SQL).",
      )
    }
    let condExpr: ExpressionNode | undefined
    if (condition) {
      const proxies = createMergeProxies<DB, Target, Source>(this._targetTable, this._sourceAlias)
      condExpr = unwrap(condition(proxies))
    }
    return this._with(this._builder.whenNotMatchedBySourceUpdate(set, condExpr))
  }

  /**
   * `WHEN NOT MATCHED BY SOURCE THEN DELETE` — deletes target rows that
   * have no matching source row.
   *
   * Supported by PostgreSQL 17+ and SQL Server. MySQL and SQLite have no
   * `MERGE` at all and will throw at print time.
   */
  whenNotMatchedBySourceThenDelete(
    condition?: (proxies: MergeProxies<DB, Target, Source>) => Expression<boolean>,
  ): TypedMergeBuilder<DB, Target, Source> {
    let condExpr: ExpressionNode | undefined
    if (condition) {
      const proxies = createMergeProxies<DB, Target, Source>(this._targetTable, this._sourceAlias)
      condExpr = unwrap(condition(proxies))
    }
    return this._with(this._builder.whenNotMatchedBySourceDelete(condExpr))
  }

  /**
   * WITH (CTE). Accepts either a raw `SelectNode` or any builder with a
   * `.build()` method (typically a `TypedSelectBuilder`).
   */
  with(
    name: string,
    query: SelectNode | { build(): SelectNode },
    options?: { recursive?: boolean },
  ): TypedMergeBuilder<DB, Target, Source> {
    const q = "build" in query ? query.build() : query
    return this._with(this._builder.with(name, q, options?.recursive === true))
  }

  /**
   * `RETURNING …` projection — accepts either plain target column names
   * or an aliased-expression object (for `merge_action()` and other
   * computed projections).
   *
   * ```ts
   * // Plain target columns
   * db.mergeInto("users", { ... })
   *   .whenMatchedThenUpdate(...)
   *   .returning("id", "name")
   *
   * // Aliased expressions — use `mergeAction()` (PG) or
   * // `mergeActionMssql()` (MSSQL) to project the branch token.
   * db.mergeInto("users", { ... })
   *   .whenMatchedThenUpdate(...)
   *   .returning({ id: col("id"), action: mergeAction() })
   * ```
   *
   * Calls accumulate across chains. The result type is a separate
   * builder shape (`TypedMergeReturningBuilder`) that strips the
   * MERGE-mutation surface — once a RETURNING is set the only useful
   * action is `.toSQL()`.
   *
   * Dialect support: PG 17+ emits `RETURNING <cols>`; MSSQL rewrites
   * to `OUTPUT <cols>` with the `INSERTED` / `DELETED` pseudo-tables
   * (bare column refs default to `INSERTED.<col>`; pass an explicit
   * `col("name", "DELETED")` for the pre-action row). MySQL/SQLite
   * have no MERGE.
   */
  returning<K extends keyof DB[Target] & string>(
    ...cols: K[]
  ): TypedMergeReturningBuilder<DB, Target, Pick<SelectRow<DB, Target>, K>>
  returning<A extends Record<string, Expression<any>>>(
    aliased: A,
  ): TypedMergeReturningBuilder<
    DB,
    Target,
    { [K in keyof A]: A[K] extends Expression<infer T> ? T : never }
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
    const builder = this._builder.returning(...exprs)
    return new TypedMergeReturningBuilder(builder, this._printer, this._compile, this._executor)
  }

  /**
   * `RETURNING *` — project every column on the target table.
   *
   * On MERGE, `*` means "the post-action row from the target", which is
   * what every dialect that supports `RETURNING` on MERGE returns. PG
   * 17+ accepts the form natively.
   */
  returningAll(): TypedMergeReturningBuilder<DB, Target, SelectRow<DB, Target>> {
    const builder = this._builder.returning(star())
    return new TypedMergeReturningBuilder(builder, this._printer, this._compile, this._executor)
  }

  build(): MergeNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Compile to SQL using the dialect's printer. */
  toSQL(): CompiledQuery {
    return this._compileNode(this.build())
  }

  /** Compile an AST this builder already produced, without building it twice. */
  private _compileNode(ast: MergeNode): CompiledQuery {
    if (this._compile) return this._compile(ast)
    if (!this._printer) {
      throw new Error("toSQL() requires a printer. Use db.mergeInto() to construct the builder.")
    }
    return this._printer.print(ast)
  }
  private _requireExecutor(): SumakExecutor {
    if (!this._executor) {
      throw new Error(
        "MERGE needs an instance to run against. Use db.mergeInto(...) so the driver is wired up.",
      )
    }
    return this._executor
  }

  /** Run the MERGE and return the number of rows it touched. */
  async run(options?: { signal?: AbortSignal }): Promise<number> {
    const exec = this._requireExecutor()
    const result = await runExecute(
      exec.driver(),
      this._compileNode(this.build()),
      options,
      listenerFor(exec),
    )
    return result.affected
  }

  /** Pre-compile the SQL with placeholders. See `TypedSelectBuilder.toCompiled()`. */
  toCompiled<P extends Record<string, unknown> = Record<string, unknown>>(): CompiledQueryFn<P> {
    if (!this._printer) {
      throw new Error(
        "toCompiled() requires a printer. Use db.mergeInto() to construct the builder.",
      )
    }
    const ast = this.build()
    const executor = this._executor
    if (executor === undefined) {
      return compileQuery<P>(ast, this._printer, this._compile)
    }
    return compileQuery<P>(ast, this._printer, this._compile, runnersFor<P, unknown>(executor, ast))
  }
}

/**
 * Returning-stage MERGE builder. Carries the row-shape parameter `R`
 * so consumers reading the AST through `.toSQL()` know what columns
 * to expect back. We deliberately don't expose the WHEN-clause
 * methods here — once you've declared a projection, adding more
 * branches would be a footgun (which branch shape applies to which
 * row?).
 */
export class TypedMergeReturningBuilder<DB, _Target extends keyof DB, _R> {
  /** @internal */
  readonly _builder: MergeBuilder
  /** @internal */
  readonly _printer?: Printer
  /** @internal */
  readonly _compile?: (node: ASTNode) => CompiledQuery
  /** @internal */
  readonly _executor?: SumakExecutor

  constructor(
    builder: MergeBuilder,
    printer?: Printer,
    compile?: (node: ASTNode) => CompiledQuery,
    executor?: SumakExecutor,
  ) {
    this._builder = builder
    this._printer = printer
    this._compile = compile
    this._executor = executor
  }

  /** Stack additional RETURNING expressions onto the projection. */
  returning(...exprs: ExpressionNode[]): TypedMergeReturningBuilder<DB, _Target, _R> {
    return new TypedMergeReturningBuilder<DB, _Target, _R>(
      this._builder.returning(...exprs),
      this._printer,
      this._compile,
      this._executor,
    )
  }

  build(): MergeNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Compile to SQL using the dialect's printer. */
  toSQL(): CompiledQuery {
    return this._compileNode(this.build())
  }

  /** Compile an AST this builder already produced, without building it twice. */
  private _compileNode(ast: MergeNode): CompiledQuery {
    if (this._compile) return this._compile(ast)
    if (!this._printer) {
      throw new Error("toSQL() requires a printer. Use db.mergeInto() to construct the builder.")
    }
    return this._printer.print(ast)
  }
  private _requireExecutor(): SumakExecutor {
    if (!this._executor) {
      throw new Error(
        "MERGE needs an instance to run against. Use db.mergeInto(...) so the driver is wired up.",
      )
    }
    return this._executor
  }

  /** Run the MERGE and return every row produced by `RETURNING`. */
  async many(options?: { signal?: AbortSignal }): Promise<_R[]> {
    const exec = this._requireExecutor()
    const ast = this.build()
    const rows = await runQuery(
      exec.driver(),
      this._compileNode(ast),
      resultTransformer(exec, deriveResultContext(ast)),
      options,
      listenerFor(exec),
    )
    return rows as unknown as _R[]
  }

  /** Run the MERGE and return the first row produced by `RETURNING`, or null. */
  async first(options?: { signal?: AbortSignal }): Promise<_R | null> {
    const rows = await this.many(options)
    return rows[0] ?? null
  }

  /** Run the MERGE and return the number of rows it touched. */
  async run(options?: { signal?: AbortSignal }): Promise<number> {
    const exec = this._requireExecutor()
    const result = await runExecute(
      exec.driver(),
      this._compileNode(this.build()),
      options,
      listenerFor(exec),
    )
    return result.affected
  }

  /** Pre-compile the SQL with placeholders. See `TypedSelectBuilder.toCompiled()`. */
  toCompiled<P extends Record<string, unknown> = Record<string, unknown>>(): CompiledQueryFn<P> {
    if (!this._printer) {
      throw new Error(
        "toCompiled() requires a printer. Use db.mergeInto() to construct the builder.",
      )
    }
    const ast = this.build()
    const executor = this._executor
    if (executor === undefined) {
      return compileQuery<P>(ast, this._printer, this._compile)
    }
    return compileQuery<P>(ast, this._printer, this._compile, runnersFor<P, unknown>(executor, ast))
  }
}
