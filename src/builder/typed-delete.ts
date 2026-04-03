import type { Expression } from "../ast/typed-expression.ts";
import { unwrap } from "../ast/typed-expression.ts";
import { star } from "../ast/expression.ts";
import type { ExpressionNode } from "../ast/nodes.ts";
import type { CompiledQuery } from "../types.ts";
import type { Printer } from "../printer/types.ts";
import type { SelectType } from "../schema/types.ts";
import { DeleteBuilder } from "./delete.ts";

/**
 * Type-safe DELETE query builder.
 */
export class TypedDeleteBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _builder: DeleteBuilder;

  constructor(table: TB & string) {
    this._builder = new DeleteBuilder().from(table);
  }

  /** @internal */
  private _with(builder: DeleteBuilder): TypedDeleteBuilder<DB, TB> {
    const t = new TypedDeleteBuilder<DB, TB>("" as TB & string);
    (t as any)._builder = builder;
    return t;
  }

  /**
   * WHERE clause.
   */
  where(expr: Expression<boolean>): TypedDeleteBuilder<DB, TB> {
    return this._with(this._builder.where(unwrap(expr)));
  }

  /**
   * RETURNING specific columns.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedDeleteReturningBuilder<DB, TB, Pick<{ [C in keyof DB[TB]]: SelectType<DB[TB][C]> }, K>> {
    const exprs: ExpressionNode[] = cols.map((c) => ({ type: "column_ref" as const, column: c }));
    return new TypedDeleteReturningBuilder(
      new DeleteBuilder({
        ...this._builder.build(),
        returning: exprs,
      }),
    );
  }

  /**
   * RETURNING all columns.
   */
  returningAll(): TypedDeleteReturningBuilder<
    DB,
    TB,
    { [K in keyof DB[TB]]: SelectType<DB[TB][K]> }
  > {
    return new TypedDeleteReturningBuilder(
      new DeleteBuilder({
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

export class TypedDeleteReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: DeleteBuilder;

  constructor(builder: DeleteBuilder) {
    this._builder = builder;
  }

  build() {
    return this._builder.build();
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build());
  }
}
