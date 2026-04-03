import type { Expression } from "../ast/typed-expression.ts";
import { unwrap } from "../ast/typed-expression.ts";
import { param, star } from "../ast/expression.ts";
import type { ExpressionNode } from "../ast/nodes.ts";
import type { CompiledQuery } from "../types.ts";
import type { Printer } from "../printer/types.ts";
import type { SelectType, Updateable } from "../schema/types.ts";
import { UpdateBuilder } from "./update.ts";

/**
 * Type-safe UPDATE query builder.
 */
export class TypedUpdateBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _builder: UpdateBuilder;
  private _paramIdx: number;

  constructor(table: TB & string, paramIdx = 0) {
    this._builder = new UpdateBuilder().table(table);
    this._paramIdx = paramIdx;
  }

  /** @internal */
  private _with(builder: UpdateBuilder, paramIdx: number): TypedUpdateBuilder<DB, TB> {
    const t = new TypedUpdateBuilder<DB, TB>("" as TB & string);
    (t as any)._builder = builder;
    (t as any)._paramIdx = paramIdx;
    return t;
  }

  /**
   * SET columns from an object. All keys optional (Updateable).
   */
  set(values: Updateable<DB[TB]>): TypedUpdateBuilder<DB, TB> {
    let builder = this._builder;
    let idx = this._paramIdx;
    for (const [col, val] of Object.entries(values as Record<string, unknown>)) {
      if (val !== undefined) {
        builder = builder.set(col, param(idx, val));
        idx++;
      }
    }
    return this._with(builder, idx);
  }

  /**
   * SET a single column with an expression.
   */
  setExpr(column: keyof DB[TB] & string, value: Expression<any>): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.set(column, unwrap(value)), this._paramIdx);
  }

  /**
   * WHERE clause.
   */
  where(expr: Expression<boolean>): TypedUpdateBuilder<DB, TB> {
    return this._with(this._builder.where(unwrap(expr)), this._paramIdx);
  }

  /**
   * RETURNING specific columns.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedUpdateReturningBuilder<DB, TB, Pick<{ [C in keyof DB[TB]]: SelectType<DB[TB][C]> }, K>> {
    const exprs: ExpressionNode[] = cols.map((c) => ({ type: "column_ref" as const, column: c }));
    return new TypedUpdateReturningBuilder(
      new UpdateBuilder({
        ...this._builder.build(),
        returning: exprs,
      }),
    );
  }

  /**
   * RETURNING all columns.
   */
  returningAll(): TypedUpdateReturningBuilder<
    DB,
    TB,
    { [K in keyof DB[TB]]: SelectType<DB[TB][K]> }
  > {
    return new TypedUpdateReturningBuilder(
      new UpdateBuilder({
        ...this._builder.build(),
        returning: [star()],
      }),
    );
  }

  build() {
    return this._builder.build();
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build());
  }
}

export class TypedUpdateReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: UpdateBuilder;

  constructor(builder: UpdateBuilder) {
    this._builder = builder;
  }

  build() {
    return this._builder.build();
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build());
  }
}
