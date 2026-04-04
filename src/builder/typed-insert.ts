import { param } from "../ast/expression.ts"
import { star } from "../ast/expression.ts"
import type { ExpressionNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { Insertable, SelectRow } from "../schema/types.ts"
import type { CompiledQuery } from "../types.ts"
import { InsertBuilder } from "./insert.ts"

/**
 * Type-safe INSERT query builder.
 */
export class TypedInsertBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _builder: InsertBuilder
  private _paramIdx: number

  constructor(table: TB & string, paramIdx = 0) {
    this._builder = new InsertBuilder().into(table)
    this._paramIdx = paramIdx
  }

  /** @internal */
  private _withBuilder(builder: InsertBuilder, paramIdx: number): TypedInsertBuilder<DB, TB> {
    const t = new TypedInsertBuilder<DB, TB>("" as TB & string)
    ;(t as any)._builder = builder
    ;(t as any)._paramIdx = paramIdx
    return t
  }

  /**
   * Insert a single row. Columns/values inferred from Insertable<DB[TB]>.
   */
  values(row: Insertable<DB[TB]>): TypedInsertBuilder<DB, TB> {
    const entries = Object.entries(row as Record<string, unknown>)
    const cols = entries.map(([k]) => k)
    const vals = entries.map(([_, v]) => {
      const p = param(this._paramIdx, v)
      this._paramIdx++
      return p
    })

    let builder = this._builder
    // Only set columns on first values() call
    if (builder.build().columns.length === 0) {
      builder = builder.columns(...cols)
    }
    builder = new InsertBuilder(
      { ...builder.build(), values: [...builder.build().values, vals] },
      this._paramIdx,
    )

    return this._withBuilder(builder, this._paramIdx)
  }

  /**
   * RETURNING specific columns.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedInsertReturningBuilder<DB, TB, Pick<SelectRow<DB, TB>, K>> {
    const exprs: ExpressionNode[] = cols.map((c) => ({ type: "column_ref" as const, column: c }))
    const builder = new InsertBuilder(
      { ...this._builder.build(), returning: exprs },
      this._paramIdx,
    )
    return new TypedInsertReturningBuilder(builder)
  }

  /**
   * RETURNING all columns.
   */
  returningAll(): TypedInsertReturningBuilder<DB, TB, SelectRow<DB, TB>> {
    const builder = new InsertBuilder(
      { ...this._builder.build(), returning: [star()] },
      this._paramIdx,
    )
    return new TypedInsertReturningBuilder(builder)
  }

  /**
   * ON CONFLICT DO NOTHING.
   */
  onConflictDoNothing(...columns: (keyof DB[TB] & string)[]): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(this._builder.onConflictDoNothing(...columns), this._paramIdx)
  }

  /**
   * ON CONFLICT DO UPDATE.
   */
  onConflictDoUpdate(
    columns: (keyof DB[TB] & string)[],
    set: { column: keyof DB[TB] & string; value: Expression<any> }[],
  ): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(
      this._builder.onConflictDoUpdate(
        columns,
        set.map((s) => ({ column: s.column, value: unwrap(s.value) })),
      ),
      this._paramIdx,
    )
  }

  build() {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }
}

export class TypedInsertReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: InsertBuilder

  constructor(builder: InsertBuilder) {
    this._builder = builder
  }

  build() {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }
}
