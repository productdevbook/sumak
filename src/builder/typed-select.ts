import type { AliasedExprNode, ExpressionNode, SelectNode, TemporalClause } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { Nullable, SelectRow } from "../schema/types.ts"
import type { CompiledQuery, OrderDirection } from "../types.ts"
import type { WhereCallback } from "./eb.ts"
import { createColumnProxies, resetParams } from "./eb.ts"
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

  constructor(builder: SelectBuilder, table?: string) {
    this._builder = builder
    this._table = (table ?? "") as TB & string
  }

  /** Select specific columns. Narrows O. */
  select<K extends keyof O & string>(...cols: K[]): TypedSelectBuilder<DB, TB, Pick<O, K>> {
    return new TypedSelectBuilder(this._builder.columns(...cols), this._table)
  }

  /** Select all columns. */
  selectAll(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.allColumns(), this._table)
  }

  /** Select with Expression<T> for computed columns. */
  selectExpr<Alias extends string, T>(
    expr: Expression<T>,
    alias: Alias,
  ): TypedSelectBuilder<DB, TB, O & Record<Alias, T>> {
    const node = unwrap(expr)
    const aliased = aliasExpr(node, alias)
    return new TypedSelectBuilder(this._builder.columns(aliased), this._table)
  }

  /** DISTINCT */
  distinct(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.distinct(), this._table)
  }

  /** DISTINCT ON (PG-specific) */
  distinctOn<K extends keyof DB[TB] & string>(...cols: K[]): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.distinctOn(...cols), this._table)
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
      resetParams()
      const cols = createColumnProxies<DB, TB>(this._table)
      const result = exprOrCallback(cols)
      return new TypedSelectBuilder(this._builder.where(unwrap(result)), this._table)
    }
    return new TypedSelectBuilder(this._builder.where(unwrap(exprOrCallback)), this._table)
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
    return new TypedSelectBuilder(this._builder.innerJoin(table, unwrap(on)), this._table)
  }

  /**
   * LEFT JOIN — joined columns become nullable.
   */
  leftJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, O & Nullable<SelectRow<DB, T>>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return new TypedSelectBuilder(this._builder.leftJoin(table, unwrap(on)), this._table)
  }

  /** RIGHT JOIN */
  rightJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, Nullable<O> & SelectRow<DB, T>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return new TypedSelectBuilder(this._builder.rightJoin(table, unwrap(on)), this._table)
  }

  /** GROUP BY */
  groupBy(...cols: (keyof O & string)[]): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.groupBy(...cols), this._table)
  }

  /** HAVING */
  having(
    exprOrCallback: Expression<boolean> | WhereCallback<DB, TB>,
  ): TypedSelectBuilder<DB, TB, O> {
    if (typeof exprOrCallback === "function") {
      resetParams()
      const cols = createColumnProxies<DB, TB>(this._table)
      const result = exprOrCallback(cols)
      return new TypedSelectBuilder(this._builder.having(unwrap(result)), this._table)
    }
    return new TypedSelectBuilder(this._builder.having(unwrap(exprOrCallback)), this._table)
  }

  /** ORDER BY */
  orderBy(
    col: keyof O & string,
    direction: OrderDirection = "ASC",
    nulls?: "FIRST" | "LAST",
  ): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.orderBy(col, direction, nulls), this._table)
  }

  /** LIMIT */
  limit(n: number): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.limit({ type: "literal", value: n }), this._table)
  }

  /** OFFSET */
  offset(n: number): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.offset({ type: "literal", value: n }), this._table)
  }

  /** FOR SYSTEM_TIME (SQL:2011 temporal query) */
  forSystemTime(clause: TemporalClause): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.forSystemTime(clause), this._table)
  }

  /** FOR UPDATE */
  forUpdate(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.forUpdate(), this._table)
  }

  /** FOR SHARE */
  forShare(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.forShare(), this._table)
  }

  /** FOR NO KEY UPDATE (PG) */
  forNoKeyUpdate(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.forNoKeyUpdate(), this._table)
  }

  /** FOR KEY SHARE (PG) */
  forKeyShare(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.forKeyShare(), this._table)
  }

  /** SKIP LOCKED — must follow a FOR lock mode */
  skipLocked(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.skipLocked(), this._table)
  }

  /** NOWAIT — must follow a FOR lock mode */
  noWait(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.noWait(), this._table)
  }

  /** WITH (CTE) */
  with(name: string, query: SelectNode, recursive = false): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.with(name, query, recursive), this._table)
  }

  /** UNION */
  union(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.union(query.build()), this._table)
  }

  /** UNION ALL */
  unionAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.unionAll(query.build()), this._table)
  }

  /** INTERSECT */
  intersect(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.intersect(query.build()), this._table)
  }

  /** INTERSECT ALL */
  intersectAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.intersectAll(query.build()), this._table)
  }

  /** EXCEPT */
  except(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.except(query.build()), this._table)
  }

  /** EXCEPT ALL */
  exceptAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.exceptAll(query.build()), this._table)
  }

  /** FULL JOIN — both sides become nullable. */
  fullJoin<T extends keyof DB & string>(
    table: T,
    onOrCallback: Expression<boolean> | ((cols: JoinProxies<DB, TB, T>) => Expression<boolean>),
  ): TypedSelectBuilder<DB, TB | T, Nullable<O> & Nullable<SelectRow<DB, T>>> {
    const on = resolveJoinOn<DB, TB, T>(onOrCallback, this._table, table)
    return new TypedSelectBuilder(this._builder.join("FULL", table, unwrap(on)), this._table)
  }

  /** CROSS JOIN — cartesian product. */
  crossJoin<T extends keyof DB & string>(
    table: T,
  ): TypedSelectBuilder<DB, TB | T, O & SelectRow<DB, T>> {
    return new TypedSelectBuilder(this._builder.join("CROSS", table), this._table)
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

  /** Build the AST node. */
  build(): SelectNode {
    return this._builder.build()
  }

  /** Compile to SQL. */
  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
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
