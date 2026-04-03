import type { ExpressionNode, SelectNode } from "../ast/nodes.ts";
import type { Expression } from "../ast/typed-expression.ts";
import { unwrap } from "../ast/typed-expression.ts";
import type { CompiledQuery, OrderDirection } from "../types.ts";
import type { Printer } from "../printer/types.ts";
import type { Nullable, SelectType } from "../schema/types.ts";
import { SelectBuilder } from "./select.ts";

/**
 * Type-safe SELECT query builder.
 *
 * DB = full database schema
 * TB = tables currently in scope (FROM + JOINs)
 * O  = output row type
 */
export class TypedSelectBuilder<DB, TB extends keyof DB, O> {
  /** @internal */
  readonly _builder: SelectBuilder;

  constructor(builder: SelectBuilder) {
    this._builder = builder;
  }

  /**
   * Select specific columns. Narrows O to only selected columns.
   */
  select<K extends keyof O & string>(...cols: K[]): TypedSelectBuilder<DB, TB, Pick<O, K>> {
    return new TypedSelectBuilder(this._builder.columns(...cols));
  }

  /**
   * Select all columns (no narrowing).
   */
  selectAll(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.allColumns());
  }

  /**
   * Select with Expression<T> for computed columns.
   */
  selectExpr<Alias extends string, T>(
    expr: Expression<T>,
    alias: Alias,
  ): TypedSelectBuilder<DB, TB, O & Record<Alias, T>> {
    const node = unwrap(expr);
    const aliased: ExpressionNode =
      node.type === "column_ref"
        ? { ...node, alias }
        : node.type === "function_call"
          ? { ...node, alias }
          : { type: "raw", sql: "", params: [] }; // fallback — should not happen normally
    return new TypedSelectBuilder(this._builder.columns(aliased));
  }

  /**
   * Add DISTINCT.
   */
  distinct(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.distinct());
  }

  /**
   * WHERE clause with type-safe expression.
   */
  where(expr: Expression<boolean>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.where(unwrap(expr)));
  }

  /**
   * INNER JOIN — adds table columns to output (non-nullable).
   */
  innerJoin<T extends keyof DB & string>(
    table: T,
    on: Expression<boolean>,
  ): TypedSelectBuilder<DB, TB | T, O & { [K in keyof DB[T]]: SelectType<DB[T][K]> }> {
    return new TypedSelectBuilder(this._builder.innerJoin(table, unwrap(on)));
  }

  /**
   * LEFT JOIN — adds table columns as nullable.
   */
  leftJoin<T extends keyof DB & string>(
    table: T,
    on: Expression<boolean>,
  ): TypedSelectBuilder<DB, TB | T, O & Nullable<{ [K in keyof DB[T]]: SelectType<DB[T][K]> }>> {
    return new TypedSelectBuilder(this._builder.leftJoin(table, unwrap(on)));
  }

  /**
   * RIGHT JOIN — adds table columns (non-nullable), existing become nullable.
   */
  rightJoin<T extends keyof DB & string>(
    table: T,
    on: Expression<boolean>,
  ): TypedSelectBuilder<DB, TB | T, Nullable<O> & { [K in keyof DB[T]]: SelectType<DB[T][K]> }> {
    return new TypedSelectBuilder(this._builder.rightJoin(table, unwrap(on)));
  }

  /**
   * GROUP BY columns.
   */
  groupBy(...cols: (keyof O & string)[]): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.groupBy(...cols));
  }

  /**
   * HAVING clause.
   */
  having(expr: Expression<boolean>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.having(unwrap(expr)));
  }

  /**
   * ORDER BY.
   */
  orderBy(
    col: keyof O & string,
    direction: OrderDirection = "ASC",
    nulls?: "FIRST" | "LAST",
  ): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.orderBy(col, direction, nulls));
  }

  /**
   * LIMIT.
   */
  limit(n: number): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.limit({ type: "literal", value: n }));
  }

  /**
   * OFFSET.
   */
  offset(n: number): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.offset({ type: "literal", value: n }));
  }

  /**
   * FOR UPDATE (PostgreSQL/MySQL).
   */
  forUpdate(): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.forUpdate());
  }

  /**
   * WITH (CTE).
   */
  with(name: string, query: SelectNode, recursive = false): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.with(name, query, recursive));
  }

  /**
   * UNION.
   */
  union(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.union(query.build()));
  }

  /**
   * UNION ALL.
   */
  unionAll(query: TypedSelectBuilder<DB, any, O>): TypedSelectBuilder<DB, TB, O> {
    return new TypedSelectBuilder(this._builder.unionAll(query.build()));
  }

  /**
   * Build the AST node (discards type info).
   */
  build(): SelectNode {
    return this._builder.build();
  }

  /**
   * Compile to SQL using a printer.
   */
  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build());
  }
}
