import type {
  AliasedExprNode,
  ExplainNode,
  ExpressionNode,
  SelectNode,
  TemporalClause,
} from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { Nullable, SelectRow } from "../schema/types.ts"
import type { CompiledQuery, OrderDirection } from "../types.ts"
import type { WhereCallback } from "./eb.ts"
import { createColumnProxies } from "./eb.ts"
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
  _compile?: (node: import("../ast/nodes.ts").ASTNode) => CompiledQuery

  constructor(
    builder: SelectBuilder,
    table?: string,
    printer?: Printer,
    compile?: (node: import("../ast/nodes.ts").ASTNode) => CompiledQuery,
  ) {
    this._builder = builder
    this._table = (table ?? "") as TB & string
    this._printer = printer
    this._compile = compile
  }

  /** Select specific columns. Narrows O. */
  select<K extends keyof O & string>(...cols: K[]): TypedSelectBuilder<DB, TB, Pick<O, K>> {
    return new TypedSelectBuilder(
      this._builder.columns(...cols),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** Select all columns. */
  selectAll(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.allColumns(),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** Select with Expression<T> for computed columns. */
  selectExpr<Alias extends string, T>(
    expr: Expression<T>,
    alias: Alias,
  ): TypedSelectBuilder<DB, TB, O & Record<Alias, T>> {
    const node = unwrap(expr)
    const aliased = aliasExpr(node, alias)
    return new TypedSelectBuilder(
      this._builder.columns(aliased),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** Select multiple aliased expressions at once. */
  selectExprs<Aliases extends Record<string, Expression<any>>>(
    exprs: Aliases,
  ): TypedSelectBuilder<DB, TB, O & { [K in keyof Aliases]: any }> {
    let builder = this._builder
    for (const [alias, expr] of Object.entries(exprs)) {
      const node = unwrap(expr as Expression<any>)
      const aliased = aliasExpr(node, alias)
      builder = builder.columns(aliased)
    }
    return new TypedSelectBuilder(builder, this._table, this._printer, this._compile)
  }

  /** DISTINCT */
  distinct(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.distinct(),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** DISTINCT ON (PG-specific) */
  distinctOn<K extends keyof DB[TB] & string>(...cols: K[]): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.distinctOn(...cols),
      this._table,
      this._printer,
      this._compile,
    )
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
      return new TypedSelectBuilder(
        this._builder.where(unwrap(result)),
        this._table,
        this._printer,
        this._compile,
      )
    }
    return new TypedSelectBuilder(
      this._builder.where(unwrap(exprOrCallback)),
      this._table,
      this._printer,
    )
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
      return new TypedSelectBuilder(
        this._builder.orWhere(unwrap(result)),
        this._table,
        this._printer,
      )
    }
    return new TypedSelectBuilder(
      this._builder.orWhere(unwrap(exprOrCallback)),
      this._table,
      this._printer,
    )
  }

  /**
   * INNER JOIN.
   *
   * ```ts
   * .innerJoin("posts", ({ users, posts }) => users.id.eqCol(posts.userId))
   * ```
   */
  innerJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, O & SelectRow<DB, T>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return new TypedSelectBuilder(
      this._builder.innerJoin(table, unwrap(on)),
      this._table,
      this._printer,
    )
  }

  /**
   * LEFT JOIN — joined columns become nullable.
   */
  leftJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, O & Nullable<SelectRow<DB, T>>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return new TypedSelectBuilder(
      this._builder.leftJoin(table, unwrap(on)),
      this._table,
      this._printer,
    )
  }

  /** RIGHT JOIN */
  rightJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, Nullable<O> & SelectRow<DB, T>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return new TypedSelectBuilder(
      this._builder.rightJoin(table, unwrap(on)),
      this._table,
      this._printer,
    )
  }

  /** GROUP BY — accepts column names or expressions */
  groupBy(...cols: ((keyof O & string) | Expression<any>)[]): TypedSelectBuilder<DB, TB, O> {
    const resolved = cols.map((c) => (typeof c === "string" ? c : unwrap(c)))
    return new TypedSelectBuilder(
      this._builder.groupBy(...resolved),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** HAVING */
  having(
    exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>,
  ): TypedSelectBuilder<DB, TB, O> {
    if (typeof exprOrCallback === "function") {
      const cols = createColumnProxies<DB, TB>(this._table)
      const result = exprOrCallback(cols)
      return new TypedSelectBuilder(
        this._builder.having(unwrap(result)),
        this._table,
        this._printer,
      )
    }
    return new TypedSelectBuilder(
      this._builder.having(unwrap(exprOrCallback)),
      this._table,
      this._printer,
    )
  }

  /** ORDER BY — accepts column name or expression */
  orderBy(
    col: (keyof O & string) | Expression<any>,
    direction: OrderDirection = "ASC",
    nulls?: "FIRST" | "LAST",
  ): TypedSelectBuilder<DB, TB, O> {
    const expr = typeof col === "string" ? col : unwrap(col)
    return new TypedSelectBuilder(
      this._builder.orderBy(expr, direction, nulls),
      this._table,
      this._printer,
    )
  }

  /** LIMIT */
  limit(n: number): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.limit({ type: "literal", value: n }),
      this._table,
      this._printer,
    )
  }

  /** OFFSET */
  offset(n: number): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.offset({ type: "literal", value: n }),
      this._table,
      this._printer,
    )
  }

  /** FOR SYSTEM_TIME (SQL:2011 temporal query) */
  forSystemTime(clause: TemporalClause): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.forSystemTime(clause),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** FOR UPDATE */
  forUpdate(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.forUpdate(),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** FOR SHARE */
  forShare(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.forShare(),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** FOR NO KEY UPDATE (PG) */
  forNoKeyUpdate(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.forNoKeyUpdate(),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** FOR KEY SHARE (PG) */
  forKeyShare(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.forKeyShare(),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** SKIP LOCKED — must follow a FOR lock mode */
  skipLocked(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.skipLocked(),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** NOWAIT — must follow a FOR lock mode */
  noWait(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.noWait(), this._table, this._printer, this._compile)
  }

  /** WITH (CTE) */
  with(name: string, query: SelectNode, recursive = false): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.with(name, query, recursive),
      this._table,
      this._printer,
    )
  }

  /** UNION */
  union(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.union(query.build()),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** UNION ALL */
  unionAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.unionAll(query.build()),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** INTERSECT */
  intersect(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.intersect(query.build()),
      this._table,
      this._printer,
    )
  }

  /** INTERSECT ALL */
  intersectAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.intersectAll(query.build()),
      this._table,
      this._printer,
    )
  }

  /** EXCEPT */
  except(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.except(query.build()),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** EXCEPT ALL */
  exceptAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      this._builder.exceptAll(query.build()),
      this._table,
      this._printer,
    )
  }

  /** FULL JOIN — both sides become nullable. */
  fullJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, Nullable<O> & Nullable<SelectRow<DB, T>>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return new TypedSelectBuilder(
      this._builder.join("FULL", table, unwrap(on)),
      this._table,
      this._printer,
    )
  }

  /** INNER JOIN LATERAL (subquery) */
  innerJoinLateral<Alias extends string, R>(
    subquery: { build(): SelectNode },
    alias: Alias,
    on: Expression<boolean>,
  ): TypedSelectBuilder<DB, TB, O & Record<Alias, R>> {
    const sub: import("../ast/nodes.ts").SubqueryNode = {
      type: "subquery",
      query: subquery.build(),
      alias,
    }
    return new TypedSelectBuilder(
      this._builder.innerJoinLateral(sub, unwrap(on)),
      this._table,
      this._printer,
    )
  }

  /** LEFT JOIN LATERAL (subquery) */
  leftJoinLateral<Alias extends string, R>(
    subquery: { build(): SelectNode },
    alias: Alias,
    on: Expression<boolean>,
  ): TypedSelectBuilder<DB, TB, O & Partial<Record<Alias, R>>> {
    const sub: import("../ast/nodes.ts").SubqueryNode = {
      type: "subquery",
      query: subquery.build(),
      alias,
    }
    return new TypedSelectBuilder(
      this._builder.leftJoinLateral(sub, unwrap(on)),
      this._table,
      this._printer,
    )
  }

  /**
   * INNER JOIN with alias — for self-joins.
   *
   * ```ts
   * .innerJoinAs("users", "u2", ({ users, u2 }) => users.managerId.eqCol(u2.id))
   * ```
   */
  innerJoinAs<T extends keyof DB & string, A extends string>(
    table: T,
    alias: A,
    onCallback: (cols: {
      [Table in (TB | A) & string]: import("./eb.ts").ColumnProxies<DB, TB>
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
    return new TypedSelectBuilder(
      this._builder.join("INNER", { type: "table_ref", name: table, alias }, unwrap(on)),
      this._table,
      this._printer,
    )
  }

  /**
   * LEFT JOIN with alias — for self-joins.
   */
  leftJoinAs<T extends keyof DB & string, A extends string>(
    table: T,
    alias: A,
    onCallback: (cols: {
      [Table in (TB | A) & string]: import("./eb.ts").ColumnProxies<DB, TB>
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
    return new TypedSelectBuilder(
      this._builder.join("LEFT", { type: "table_ref", name: table, alias }, unwrap(on)),
      this._table,
      this._printer,
    )
  }

  /** CROSS JOIN — cartesian product. */
  crossJoin<T extends keyof DB & string>(
    table: T,
  ): TypedSelectBuilder<DB, TB | T, O & SelectRow<DB, T>> {
    return new TypedSelectBuilder(
      this._builder.join("CROSS", table),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** CROSS JOIN LATERAL (subquery) */
  crossJoinLateral<Alias extends string, R>(
    subquery: { build(): SelectNode },
    alias: Alias,
  ): TypedSelectBuilder<DB, TB, O & Record<Alias, R>> {
    const sub: import("../ast/nodes.ts").SubqueryNode = {
      type: "subquery",
      query: subquery.build(),
      alias,
    }
    return new TypedSelectBuilder(
      this._builder.crossJoinLateral(sub),
      this._table,
      this._printer,
      this._compile,
    )
  }

  /** Clear WHERE clause. */
  clearWhere(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      new SelectBuilder({ ...this._builder.build(), where: undefined }),
      this._table,
      this._printer,
    )
  }

  /** Clear ORDER BY clause. */
  clearOrderBy(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      new SelectBuilder({ ...this._builder.build(), orderBy: [] }),
      this._table,
      this._printer,
    )
  }

  /** Clear LIMIT. */
  clearLimit(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      new SelectBuilder({ ...this._builder.build(), limit: undefined }),
      this._table,
      this._printer,
    )
  }

  /** Clear OFFSET. */
  clearOffset(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      new SelectBuilder({ ...this._builder.build(), offset: undefined }),
      this._table,
      this._printer,
    )
  }

  /** Clear GROUP BY clause. */
  clearGroupBy(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      new SelectBuilder({ ...this._builder.build(), groupBy: [] }),
      this._table,
      this._printer,
    )
  }

  /** Clear HAVING clause. */
  clearHaving(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      new SelectBuilder({ ...this._builder.build(), having: undefined }),
      this._table,
      this._printer,
    )
  }

  /** Clear SELECT columns (resets to empty). */
  clearSelect(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(
      new SelectBuilder({ ...this._builder.build(), columns: [] }),
      this._table,
      this._printer,
    )
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
      const condition: import("../ast/nodes.ts").ExpressionNode = {
        type: "binary_op",
        op: ">",
        left: { type: "column_ref", column },
        right: { type: "param", index: 0, value: after },
      }
      builder = builder.where(condition)
      builder = builder.orderBy(column, "ASC")
    } else if (before !== undefined) {
      const condition: import("../ast/nodes.ts").ExpressionNode = {
        type: "binary_op",
        op: "<",
        left: { type: "column_ref", column },
        right: { type: "param", index: 0, value: before },
      }
      builder = builder.where(condition)
      builder = builder.orderBy(column, "DESC")
    }

    builder = builder.limit({ type: "literal", value: pageSize + 1 })

    return new TypedSelectBuilder(builder, this._table, this._printer, this._compile)
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

  /** EXPLAIN this query. */
  explain(options?: { analyze?: boolean; format?: "TEXT" | "JSON" | "YAML" | "XML" }): {
    build(): ExplainNode
    compile(printer: Printer): CompiledQuery
  } {
    const node = this.build()
    const explainNode: ExplainNode = {
      type: "explain",
      statement: node,
      analyze: options?.analyze,
      format: options?.format,
    }
    return {
      build: () => explainNode,
      compile: (printer: Printer) => printer.print(explainNode),
    }
  }
}

// ── Join helpers ──

import type { ColumnProxies } from "./eb.ts"
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
