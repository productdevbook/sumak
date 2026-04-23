import { param as rawParam } from "../ast/expression.ts"
import type {
  AliasedExprNode,
  ASTNode,
  ExplainNode,
  ExpressionNode,
  SelectNode,
  SubqueryNode,
  TemporalClause,
} from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import { resultTransformer, runFirst, runOne, runQuery } from "../driver/execute.ts"
import type { SumakExecutor } from "../driver/execute.ts"
import type { Row } from "../driver/types.ts"
import { deriveResultContext } from "../plugin/result-context.ts"
import type { Printer } from "../printer/types.ts"
import type { Nullable, SelectRow } from "../schema/types.ts"
import type { CompiledQuery, OrderDirection } from "../types.ts"
import type { CompiledQueryFn } from "./compiled.ts"
import { compileQuery } from "./compiled.ts"
import type { ColumnProxies, WhereCallback } from "./eb.ts"
import { createColumnProxies } from "./eb.ts"
import { ExplainBuilder } from "./explain.ts"
import { SelectBuilder } from "./select.ts"

/**
 * Type-safe SELECT query builder.
 *
 * DB = full database schema
 * TB = tables currently in scope (FROM + JOINs)
 * O  = output row type
 */
export class TypedSelectBuilder<DB, TB extends keyof DB, O> {
  /** @internal */
  readonly _builder: SelectBuilder
  private _table: TB & string
  private _printer?: Printer
  /** @internal — full compile pipeline (plugins + hooks + printer) */
  _compile?: (node: ASTNode) => CompiledQuery
  /** @internal — executor from the owning Sumak instance, if any */
  _executor?: SumakExecutor

  constructor(
    builder: SelectBuilder,
    table?: string,
    printer?: Printer,
    compile?: (node: ASTNode) => CompiledQuery,
    executor?: SumakExecutor,
  ) {
    this._builder = builder
    this._table = (table ?? "") as TB & string
    this._printer = printer
    this._compile = compile
    this._executor = executor
  }

  /**
   * Clone this builder with a new inner `SelectBuilder`, preserving
   * table name, printer, compile pipeline, and executor. Every chain
   * step (.select, .where, .orderBy, …) routes through this so the
   * driver/result context survives the whole chain — without it, any
   * `this._executor` stays behind on the original builder and
   * `.many()` at the end of the chain would throw "no executor".
   */
  protected _chain<O2 = O>(builder: SelectBuilder): TypedSelectBuilder<DB, TB, O2> {
    return new TypedSelectBuilder<DB, TB, O2>(
      builder,
      this._table,
      this._printer,
      this._compile,
      this._executor,
    )
  }

  /**
   * Select specific columns or aliased expressions.
   *
   * Two forms, both supported in a single method:
   *
   * ```ts
   * // Column names (narrows output row)
   * db.selectFrom("users").select("id", "name")
   * // → SELECT "id", "name" FROM "users"
   *
   * // Aliased expressions (object form — alias on the left)
   * db.selectFrom("users").select({ total: count(), upperName: str.upper(col.name) })
   * // → SELECT count() AS "total", UPPER("name") AS "upperName" FROM "users"
   * ```
   *
   * The two forms can be chained: `.select("id", "name").select({ total: count() })`.
   */
  select<K extends keyof O & string>(...cols: K[]): TypedSelectBuilder<DB, TB, Pick<O, K>>
  select<A extends Record<string, Expression<any>>>(
    aliased: A,
  ): TypedSelectBuilder<
    DB,
    TB,
    O & { [K in keyof A]: A[K] extends Expression<infer T> ? T : never }
  >
  select(...args: unknown[]): any {
    // Aliased-expression object form: single arg, plain object.
    if (
      args.length === 1 &&
      typeof args[0] === "object" &&
      args[0] !== null &&
      !Array.isArray(args[0])
    ) {
      const aliased = args[0] as Record<string, Expression<any>>
      const entries = Object.entries(aliased)
      if (entries.length === 0) {
        throw new Error(
          ".select({}) requires at least one aliased expression — empty object is invalid.",
        )
      }
      let builder = this._builder
      for (const [alias, expr] of entries) {
        const node = unwrap(expr as Expression<any>)
        builder = builder.columns(aliasExpr(node, alias))
      }
      return this._chain(builder)
    }
    // Column-name form.
    if (args.length === 0) {
      throw new Error(".select() requires at least one column or expression.")
    }
    return this._chain(this._builder.columns(...(args as string[])))
  }

  /** Select all columns. */
  selectAll(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.allColumns())
  }

  /**
   * Bypass the soft-delete filter for this query — includes rows where
   * `deleted_at IS NOT NULL`. No-op when the softDelete plugin is not
   * registered for this table.
   *
   * Last-call wins: calling `.onlyDeleted()` after this replaces the mode.
   */
  includeDeleted(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.withSoftDeleteMode("include"))
  }

  /**
   * Invert the soft-delete filter for this query — returns ONLY
   * soft-deleted rows (`deleted_at IS NOT NULL`).
   *
   * Last-call wins: calling `.includeDeleted()` after this replaces the mode.
   */
  onlyDeleted(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.withSoftDeleteMode("only"))
  }

  /** DISTINCT */
  distinct(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.distinct())
  }

  /** DISTINCT ON (PG-specific) */
  distinctOn<K extends keyof DB[TB] & string>(...cols: K[]): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.distinctOn(...cols))
  }

  /**
   * WHERE — accepts callback with typed column proxies OR raw Expression.
   *
   * ```ts
   * // Callback style (recommended)
   * .where(({ id, name }) => id.eq(42))
   * .where(({ age }) => age.between(18, 65))
   *
   * // Raw Expression style
   * .where(typedEq(typedCol<number>("id"), typedParam(0, 42)))
   * ```
   */
  where(
    exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>,
  ): TypedSelectBuilder<DB, TB, O> {
    if (typeof exprOrCallback === "function") {
      const cols = createColumnProxies<DB, TB>(this._table)
      const result = exprOrCallback(cols)
      return this._chain(this._builder.where(unwrap(result)))
    }
    return this._chain(this._builder.where(unwrap(exprOrCallback)))
  }

  /**
   * OR WHERE — ORs with existing WHERE clause instead of AND.
   */
  orWhere(
    exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>,
  ): TypedSelectBuilder<DB, TB, O> {
    if (typeof exprOrCallback === "function") {
      const cols = createColumnProxies<DB, TB>(this._table)
      const result = exprOrCallback(cols)
      return this._chain(this._builder.orWhere(unwrap(result)))
    }
    return this._chain(this._builder.orWhere(unwrap(exprOrCallback)))
  }

  /**
   * INNER JOIN.
   *
   * ```ts
   * .innerJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))
   * ```
   */
  innerJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, O & SelectRow<DB, T>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return this._chain(this._builder.innerJoin(table, unwrap(on)))
  }

  /**
   * LEFT JOIN — joined columns become nullable.
   */
  leftJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, O & Nullable<SelectRow<DB, T>>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return this._chain(this._builder.leftJoin(table, unwrap(on)))
  }

  /** RIGHT JOIN */
  rightJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, Nullable<O> & SelectRow<DB, T>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return this._chain(this._builder.rightJoin(table, unwrap(on)))
  }

  /** GROUP BY — accepts column names or expressions */
  groupBy(...cols: ((keyof O & string) | Expression<any>)[]): TypedSelectBuilder<DB, TB, O> {
    const resolved = cols.map((c) => (typeof c === "string" ? c : unwrap(c)))
    return this._chain(this._builder.groupBy(...resolved))
  }

  /** HAVING */
  having(
    exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>,
  ): TypedSelectBuilder<DB, TB, O> {
    if (typeof exprOrCallback === "function") {
      const cols = createColumnProxies<DB, TB>(this._table)
      const result = exprOrCallback(cols)
      return this._chain(this._builder.having(unwrap(result)))
    }
    return this._chain(this._builder.having(unwrap(exprOrCallback)))
  }

  /** ORDER BY — accepts column name or expression */
  orderBy(
    col: (keyof O & string) | Expression<any>,
    direction: OrderDirection = "ASC",
    nulls?: "FIRST" | "LAST",
  ): TypedSelectBuilder<DB, TB, O> {
    const expr = typeof col === "string" ? col : unwrap(col)
    return this._chain(this._builder.orderBy(expr, direction, nulls))
  }

  /** LIMIT */
  limit(n: number): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.limit({ type: "literal", value: n }))
  }

  /** OFFSET */
  offset(n: number): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.offset({ type: "literal", value: n }))
  }

  /** FOR SYSTEM_TIME (SQL:2011 temporal query) */
  forSystemTime(clause: TemporalClause): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.forSystemTime(clause))
  }

  /**
   * Row-level lock — unified form for `FOR UPDATE` / `FOR SHARE` /
   * `FOR NO KEY UPDATE` / `FOR KEY SHARE` with optional `SKIP LOCKED`
   * or `NOWAIT` modifiers.
   *
   * ```ts
   * .lock({ mode: "update" })                          // FOR UPDATE
   * .lock({ mode: "share" })                           // FOR SHARE
   * .lock({ mode: "no_key_update" })                   // FOR NO KEY UPDATE (PG)
   * .lock({ mode: "key_share" })                       // FOR KEY SHARE (PG)
   * .lock({ mode: "update", skipLocked: true })        // FOR UPDATE SKIP LOCKED
   * .lock({ mode: "update", noWait: true })            // FOR UPDATE NOWAIT
   * ```
   *
   * `skipLocked` and `noWait` are mutually exclusive — setting both
   * throws. The old `forUpdate() / forShare() / forNoKeyUpdate() /
   * forKeyShare() / skipLocked() / noWait()` methods have been removed
   * in favor of this single options-object form.
   */
  lock(options: {
    mode: "update" | "share" | "no_key_update" | "key_share"
    skipLocked?: boolean
    noWait?: boolean
    /**
     * PostgreSQL `FOR UPDATE OF t1, t2`. Restrict row-level locks to
     * specific tables — useful for multi-table joins where only one
     * side genuinely needs locking. Accepts table names from the
     * current scope.
     */
    of?: (keyof DB & string)[]
  }): TypedSelectBuilder<DB, TB, O> {
    if (options.skipLocked === true && options.noWait === true) {
      throw new Error(".lock() cannot set both skipLocked and noWait — SQL only allows one.")
    }
    const mode = options.mode
    let builder: SelectBuilder
    switch (mode) {
      case "update":
        builder = this._builder.forUpdate()
        break
      case "share":
        builder = this._builder.forShare()
        break
      case "no_key_update":
        builder = this._builder.forNoKeyUpdate()
        break
      case "key_share":
        builder = this._builder.forKeyShare()
        break
    }
    if (options.of && options.of.length > 0) builder = builder.lockOf(options.of as string[])
    if (options.skipLocked) builder = builder.skipLocked()
    if (options.noWait) builder = builder.noWait()
    return this._chain(builder)
  }

  /**
   * WITH (CTE). Accepts either a raw `SelectNode` or any `TypedSelectBuilder`
   * — passing the builder directly saves a `.build()` at the call site.
   */
  with(
    name: string,
    query: SelectNode | { build(): SelectNode },
    options?: { recursive?: boolean },
  ): TypedSelectBuilder<DB, TB, O> {
    const q = "build" in query ? query.build() : query
    return this._chain(this._builder.with(name, q, options?.recursive === true))
  }

  /** UNION */
  union(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.union(query.build()))
  }

  /** UNION ALL */
  unionAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.unionAll(query.build()))
  }

  /** INTERSECT */
  intersect(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.intersect(query.build()))
  }

  /** INTERSECT ALL */
  intersectAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.intersectAll(query.build()))
  }

  /** EXCEPT */
  except(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.except(query.build()))
  }

  /** EXCEPT ALL */
  exceptAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return this._chain(this._builder.exceptAll(query.build()))
  }

  /** FULL JOIN — both sides become nullable. */
  fullJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, Nullable<O> & Nullable<SelectRow<DB, T>>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return this._chain(this._builder.join("FULL", table, unwrap(on)))
  }

  /** INNER JOIN LATERAL (subquery) */
  innerJoinLateral<Alias extends string, R>(
    subquery: { build(): SelectNode },
    alias: Alias,
    on: Expression<boolean>,
  ): TypedSelectBuilder<DB, TB, O & Record<Alias, R>> {
    const sub: SubqueryNode = {
      type: "subquery",
      query: subquery.build(),
      alias,
    }
    return this._chain(this._builder.innerJoinLateral(sub, unwrap(on)))
  }

  /** LEFT JOIN LATERAL (subquery) */
  leftJoinLateral<Alias extends string, R>(
    subquery: { build(): SelectNode },
    alias: Alias,
    on: Expression<boolean>,
  ): TypedSelectBuilder<DB, TB, O & Partial<Record<Alias, R>>> {
    const sub: SubqueryNode = {
      type: "subquery",
      query: subquery.build(),
      alias,
    }
    return this._chain(this._builder.leftJoinLateral(sub, unwrap(on)))
  }

  /**
   * INNER JOIN with alias — for self-joins.
   *
   * ```ts
   * .innerJoinAs("users", "u2", ({ users, u2 }) => users.managerId.eq(u2.id))
   * ```
   */
  innerJoinAs<T extends keyof DB & string, A extends string>(
    table: T,
    alias: A,
    onCallback: (cols: {
      [Table in (TB | A) & string]: ColumnProxies<DB, TB>
    }) => Expression<boolean>,
  ): TypedSelectBuilder<DB, TB | T, O & SelectRow<DB, T>> {
    const proxies = new Proxy({} as any, {
      get(_target: any, tableName: string) {
        return new Proxy(
          {},
          {
            get(_t2: any, colName: string) {
              return new Col(colName, tableName)
            },
          },
        )
      },
    })
    const on = onCallback(proxies)
    return this._chain(
      this._builder.join("INNER", { type: "table_ref", name: table, alias }, unwrap(on)),
    )
  }

  /**
   * LEFT JOIN with alias — for self-joins.
   */
  leftJoinAs<T extends keyof DB & string, A extends string>(
    table: T,
    alias: A,
    onCallback: (cols: {
      [Table in (TB | A) & string]: ColumnProxies<DB, TB>
    }) => Expression<boolean>,
  ): TypedSelectBuilder<DB, TB | T, O & Nullable<SelectRow<DB, T>>> {
    const proxies = new Proxy({} as any, {
      get(_target: any, tableName: string) {
        return new Proxy(
          {},
          {
            get(_t2: any, colName: string) {
              return new Col(colName, tableName)
            },
          },
        )
      },
    })
    const on = onCallback(proxies)
    return this._chain(
      this._builder.join("LEFT", { type: "table_ref", name: table, alias }, unwrap(on)),
    )
  }

  /** CROSS JOIN — cartesian product. */
  crossJoin<T extends keyof DB & string>(
    table: T,
  ): TypedSelectBuilder<DB, TB | T, O & SelectRow<DB, T>> {
    return this._chain(this._builder.join("CROSS", table))
  }

  /** CROSS JOIN LATERAL (subquery) */
  crossJoinLateral<Alias extends string, R>(
    subquery: { build(): SelectNode },
    alias: Alias,
  ): TypedSelectBuilder<DB, TB, O & Record<Alias, R>> {
    const sub: SubqueryNode = {
      type: "subquery",
      query: subquery.build(),
      alias,
    }
    return this._chain(this._builder.crossJoinLateral(sub))
  }

  /** Clear WHERE clause. */
  clearWhere(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(new SelectBuilder({ ...this._builder.build(), where: undefined }))
  }

  /** Clear ORDER BY clause. */
  clearOrderBy(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(new SelectBuilder({ ...this._builder.build(), orderBy: [] }))
  }

  /** Clear LIMIT. */
  clearLimit(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(new SelectBuilder({ ...this._builder.build(), limit: undefined }))
  }

  /** Clear OFFSET. */
  clearOffset(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(new SelectBuilder({ ...this._builder.build(), offset: undefined }))
  }

  /** Clear GROUP BY clause. */
  clearGroupBy(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(new SelectBuilder({ ...this._builder.build(), groupBy: [] }))
  }

  /** Clear HAVING clause. */
  clearHaving(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(new SelectBuilder({ ...this._builder.build(), having: undefined }))
  }

  /** Clear SELECT columns (resets to empty). */
  clearSelect(): TypedSelectBuilder<DB, TB, O> {
    return this._chain(new SelectBuilder({ ...this._builder.build(), columns: [] }))
  }

  /** Pipe builder through a function for reusable query fragments. */
  $call<R>(fn: (qb: TypedSelectBuilder<DB, TB, O>) => R): R {
    return fn(this)
  }

  /** Conditionally apply a transformation. */
  $if<O2>(
    condition: boolean,
    fn: (qb: TypedSelectBuilder<DB, TB, O>) => TypedSelectBuilder<DB, TB, O2>,
  ): TypedSelectBuilder<DB, TB, O | O2> {
    if (condition) {
      return fn(this) as any
    }
    return this as any
  }

  /**
   * Cursor-based (keyset) pagination.
   *
   * Adds WHERE column > cursor (ASC) or column < cursor (DESC),
   * ORDER BY column, and LIMIT pageSize + 1 (for hasNextPage detection).
   *
   * ```ts
   * db.selectFrom("users")
   *   .select("id", "name")
   *   .cursorPaginate({ column: "id", after: 42, pageSize: 20 })
   *   .toSQL()
   * ```
   */
  cursorPaginate(options: {
    column: keyof O & string
    after?: unknown
    before?: unknown
    pageSize: number
  }): TypedSelectBuilder<DB, TB, O> {
    const { column, after, before, pageSize } = options
    let builder: SelectBuilder = this._builder

    if (after !== undefined) {
      const condition: ExpressionNode = {
        type: "binary_op",
        op: ">",
        left: { type: "column_ref", column },
        right: rawParam(0, after),
      }
      builder = builder.where(condition)
      builder = builder.orderBy(column, "ASC")
    } else if (before !== undefined) {
      const condition: ExpressionNode = {
        type: "binary_op",
        op: "<",
        left: { type: "column_ref", column },
        right: rawParam(0, before),
      }
      builder = builder.where(condition)
      builder = builder.orderBy(column, "DESC")
    }

    builder = builder.limit({ type: "literal", value: pageSize + 1 })

    return this._chain(builder)
  }

  /** Build the AST node. */
  build(): SelectNode {
    return this._builder.build()
  }

  /** Compile to SQL with explicit printer. */
  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Compile to SQL using the dialect's printer. */
  toSQL(): CompiledQuery {
    if (this._compile) {
      return this._compile(this.build())
    }
    if (!this._printer) {
      throw new Error(
        "toSQL() requires a printer. Use db.selectFrom() or pass a printer to compile().",
      )
    }
    return this._printer.print(this.build())
  }

  /**
   * Execute this SELECT and return every matching row. Applies
   * `result:transform` plugins + hooks. Typed as the builder's output
   * row shape `O`.
   *
   * Requires a driver — `sumak({ …, driver })`. Without one, throws
   * {@link import("../driver/execute.ts").MissingDriverError}.
   */
  async many(): Promise<O[]> {
    const exec = this._requireExecutor()
    const ast = this.build()
    const ctx = deriveResultContext(ast)
    const rows = await runQuery(exec.driver(), this.toSQL(), resultTransformer(exec, ctx))
    return rows as unknown as O[]
  }

  /**
   * Execute this SELECT and return the single matching row. Throws
   * `UnexpectedRowCountError` if zero or >1 rows come back. Use when
   * the query's shape (e.g. primary-key lookup) guarantees one row.
   */
  async one(): Promise<O> {
    const exec = this._requireExecutor()
    const ast = this.build()
    const ctx = deriveResultContext(ast)
    const row = await runOne(exec.driver(), this.toSQL(), resultTransformer(exec, ctx))
    return row as unknown as O
  }

  /**
   * Execute this SELECT and return the first row, or `null` if there
   * are no rows. The query is not implicitly `LIMIT 1`-ed — use
   * `.limit(1)` if you want that.
   */
  async first(): Promise<O | null> {
    const exec = this._requireExecutor()
    const ast = this.build()
    const ctx = deriveResultContext(ast)
    const row = await runFirst(exec.driver(), this.toSQL(), resultTransformer(exec, ctx))
    return row as unknown as O | null
  }

  private _requireExecutor(): SumakExecutor {
    if (!this._executor) {
      throw new Error(
        "execute methods (many/one/first) are only available on builders created through " +
          "a sumak() instance — e.g. `db.selectFrom('users').many()`. A standalone " +
          "TypedSelectBuilder was constructed without an executor.",
      )
    }
    return this._executor
  }

  /**
   * Wrap this query in `EXPLAIN` — returns a chainable `ExplainBuilder` with
   * the same `build()` / `compile(printer)` / `toSQL()` surface as DML
   * builders. No more awkward `{ build, compile }` destructuring.
   */
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

  /**
   * Partial-evaluate this query: compile the SQL once and return a function
   * that fills `placeholder()` slots at call time. Subsequent calls skip the
   * AST walk — only parameters change.
   *
   * ```ts
   * const findUser = db.selectFrom("users")
   *   .where(({ id }) => id.eq(placeholder("userId")))
   *   .toCompiled<{ userId: number }>()
   *
   * findUser({ userId: 1 })   // { sql: '...', params: [1] }
   * findUser({ userId: 99 })  // same SQL, different params
   * ```
   */
  toCompiled<P extends Record<string, unknown> = Record<string, unknown>>(): CompiledQueryFn<P> {
    if (!this._printer) {
      throw new Error(
        "toCompiled() requires a printer. Use db.selectFrom() to construct the builder.",
      )
    }
    return compileQuery<P>(this.build(), this._printer, this._compile)
  }
}

// ── Join helpers ──

import { Col } from "./eb.ts"

type JoinProxies<DB, TB extends keyof DB, T extends keyof DB> = {
  [Table in (TB | T) & string]: ColumnProxies<DB, Table>
}

function createJoinProxies<DB, TB extends keyof DB, T extends keyof DB>(
  _leftTable: TB & string,
  _rightTable: T & string,
): JoinProxies<DB, TB, T> {
  return new Proxy({} as JoinProxies<DB, TB, T>, {
    get(_target, tableName: string) {
      return new Proxy(
        {},
        {
          get(_t2, colName: string) {
            return new Col(colName, tableName)
          },
        },
      )
    },
  })
}

function aliasExpr(node: ExpressionNode, alias: string): ExpressionNode {
  // Node types that support alias directly
  if (
    node.type === "column_ref" ||
    node.type === "function_call" ||
    node.type === "json_access" ||
    node.type === "window_function"
  ) {
    return { ...node, alias }
  }
  // Generic aliased wrapper for everything else
  const aliased: AliasedExprNode = { type: "aliased_expr", expr: node, alias }
  return aliased
}

function resolveJoinOn<DB, TB extends keyof DB, T extends keyof DB>(
  onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  leftTable: TB & string,
  rightTable: T & string,
): Expression<boolean> {
  if (typeof onOrCallback === "function") {
    const proxies = createJoinProxies<DB, TB, T>(leftTable, rightTable)
    return onOrCallback(proxies)
  }
  return onOrCallback
}
