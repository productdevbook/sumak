import { param } from "../ast/expression.ts"
import { star } from "../ast/expression.ts"
import type { ExpressionNode, InsertNode, SelectNode } from "../ast/nodes.ts"
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
  /** @internal */
  _printer?: Printer

  constructor(table: TB & string) {
    this._builder = new InsertBuilder().into(table)
  }

  /** @internal */
  private _withBuilder(builder: InsertBuilder): TypedInsertBuilder<DB, TB> {
    const t = new TypedInsertBuilder<DB, TB>("" as TB & string)
    ;(t as any)._builder = builder
    ;(t as any)._printer = this._printer
    return t
  }

  /**
   * Insert a single row. Columns/values inferred from Insertable<DB[TB]>.
   */
  values(row: Insertable<DB[TB]>): TypedInsertBuilder<DB, TB> {
    const entries = Object.entries(row as Record<string, unknown>)
    const cols = entries.map(([k]) => k)
    const vals = entries.map(([_, v]) => param(0, v))

    let builder = this._builder
    // Only set columns on first values() call
    if (builder.build().columns.length === 0) {
      builder = builder.columns(...cols)
    }
    builder = new InsertBuilder({
      ...builder.build(),
      values: [...builder.build().values, vals],
    })

    return this._withBuilder(builder)
  }

  /**
   * Insert multiple rows at once.
   */
  valuesMany(rows: Insertable<DB[TB]>[]): TypedInsertBuilder<DB, TB> {
    let current: TypedInsertBuilder<DB, TB> = this
    for (const row of rows) {
      current = current.values(row)
    }
    return current
  }

  /**
   * RETURNING specific columns.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedInsertReturningBuilder<DB, TB, Pick<SelectRow<DB, TB>, K>> {
    const exprs: ExpressionNode[] = cols.map((c) => ({ type: "column_ref" as const, column: c }))
    const builder = new InsertBuilder({
      ...this._builder.build(),
      returning: exprs,
    })
    return new TypedInsertReturningBuilder(builder)
  }

  /**
   * RETURNING with expression and alias.
   */
  returningExpr<Alias extends string>(
    expr: Expression<any>,
    alias: Alias,
  ): TypedInsertReturningBuilder<DB, TB, SelectRow<DB, TB> & Record<Alias, any>> {
    const node = unwrap(expr)
    const aliased: import("../ast/nodes.ts").AliasedExprNode = {
      type: "aliased_expr",
      expr: node,
      alias,
    }
    const builder = new InsertBuilder({
      ...this._builder.build(),
      returning: [...this._builder.build().returning, aliased],
    })
    return new TypedInsertReturningBuilder(builder)
  }

  /**
   * RETURNING all columns.
   */
  returningAll(): TypedInsertReturningBuilder<DB, TB, SelectRow<DB, TB>> {
    const builder = new InsertBuilder({
      ...this._builder.build(),
      returning: [star()],
    })
    return new TypedInsertReturningBuilder(builder)
  }

  /**
   * ON CONFLICT DO NOTHING.
   */
  onConflictDoNothing(...columns: (keyof DB[TB] & string)[]): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(this._builder.onConflictDoNothing(...columns))
  }

  /**
   * ON CONFLICT DO UPDATE — with Expression values.
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
    )
  }

  /**
   * ON CONFLICT DO UPDATE — with plain object (auto-parameterized).
   */
  onConflictDoUpdateSet(
    columns: (keyof DB[TB] & string)[],
    values: Partial<Insertable<DB[TB]>>,
  ): TypedInsertBuilder<DB, TB> {
    const set: { column: string; value: ExpressionNode }[] = []
    for (const [col, val] of Object.entries(values as Record<string, unknown>)) {
      if (val !== undefined) {
        set.push({ column: col, value: param(0, val) })
      }
    }
    return this._withBuilder(this._builder.onConflictDoUpdate(columns, set))
  }

  /** ON CONFLICT ON CONSTRAINT name DO NOTHING */
  onConflictConstraintDoNothing(constraint: string): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(this._builder.onConflictConstraintDoNothing(constraint))
  }

  /** ON CONFLICT ON CONSTRAINT name DO UPDATE SET ... */
  onConflictConstraintDoUpdate(
    constraint: string,
    set: { column: keyof DB[TB] & string; value: Expression<any> }[],
  ): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(
      this._builder.onConflictConstraintDoUpdate(
        constraint,
        set.map((s) => ({ column: s.column, value: unwrap(s.value) })),
      ),
    )
  }

  /** INSERT OR IGNORE (SQLite) */
  orIgnore(): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(this._builder.orIgnore())
  }

  /** INSERT OR REPLACE (SQLite) */
  orReplace(): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(this._builder.orReplace())
  }

  /** MySQL: ON DUPLICATE KEY UPDATE */
  onDuplicateKeyUpdate(
    set: { column: keyof DB[TB] & string; value: Expression<any> }[],
  ): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(
      this._builder.onDuplicateKeyUpdate(
        set.map((s) => ({ column: s.column, value: unwrap(s.value) })),
      ),
    )
  }

  /** INSERT INTO ... SELECT ... */
  fromSelect(query: SelectNode): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(this._builder.fromSelect(query))
  }

  /** INSERT INTO ... DEFAULT VALUES */
  defaultValues(): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(this._builder.defaultValues())
  }

  /** WITH (CTE) */
  with(name: string, query: SelectNode, recursive = false): TypedInsertBuilder<DB, TB> {
    return this._withBuilder(this._builder.with(name, query, recursive))
  }

  /** Conditionally apply a transformation. */
  $if(
    condition: boolean,
    fn: (qb: TypedInsertBuilder<DB, TB>) => TypedInsertBuilder<DB, TB>,
  ): TypedInsertBuilder<DB, TB> {
    if (condition) {
      return fn(this)
    }
    return this
  }

  build(): InsertNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Compile to SQL using the dialect's printer. */
  toSQL(): CompiledQuery {
    if (!this._printer) {
      throw new Error(
        "toSQL() requires a printer. Use db.insertInto() or pass a printer to compile().",
      )
    }
    return this._printer.print(this.build())
  }

  /** EXPLAIN this query. */
  explain(options?: { analyze?: boolean; format?: "TEXT" | "JSON" | "YAML" | "XML" }): {
    build(): import("../ast/nodes.ts").ExplainNode
    compile(printer: Printer): CompiledQuery
  } {
    const node = this.build()
    const explainNode: import("../ast/nodes.ts").ExplainNode = {
      type: "explain",
      statement: node,
      analyze: options?.analyze,
      format: options?.format,
    }
    return {
      build: () => explainNode,
      compile: (p: Printer) => p.print(explainNode),
    }
  }
}

export class TypedInsertReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: InsertBuilder

  constructor(builder: InsertBuilder) {
    this._builder = builder
  }

  build(): InsertNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }
}
