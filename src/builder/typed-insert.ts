import { param } from "../ast/expression.ts"
import { star } from "../ast/expression.ts"
import type { ExpressionNode, InsertNode, SelectNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { Insertable, SelectRow } from "../schema/types.ts"
import type { CompiledQuery } from "../types.ts"
import { ExplainBuilder } from "./explain.ts"
import { InsertBuilder } from "./insert.ts"

/**
 * Type-safe INSERT query builder.
 */
export class TypedInsertBuilder<DB, TB extends keyof DB> {
  /** @internal */
  readonly _builder: InsertBuilder
  /** @internal */
  _printer?: Printer
  /** @internal */
  _compile?: (node: import("../ast/nodes.ts").ASTNode) => CompiledQuery

  constructor(table: TB & string) {
    this._builder = new InsertBuilder().into(table)
  }

  /** @internal */
  private _withBuilder(builder: InsertBuilder): TypedInsertBuilder<DB, TB> {
    const t = new TypedInsertBuilder<DB, TB>("" as TB & string)
    ;(t as any)._builder = builder
    ;(t as any)._printer = this._printer
    ;(t as any)._compile = this._compile
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
   * RETURNING columns or aliased expressions.
   *
   * ```ts
   * // Plain columns
   * db.insertInto("users").values(...).returning("id", "name")
   *
   * // Aliased expressions (object form)
   * db.insertInto("users").values(...).returning({
   *   id: col("id"),
   *   upperName: str.upper(col("name")),
   * })
   * ```
   *
   * Accumulates across chained calls — use `.returningAll()` to reset.
   */
  returning<K extends keyof DB[TB] & string>(
    ...cols: K[]
  ): TypedInsertReturningBuilder<DB, TB, Pick<SelectRow<DB, TB>, K>>
  returning<A extends Record<string, Expression<any>>>(
    aliased: A,
  ): TypedInsertReturningBuilder<
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
    const builder = new InsertBuilder({
      ...this._builder.build(),
      returning: [...existing, ...exprs],
    })
    return new TypedInsertReturningBuilder(builder, this._printer, this._compile)
  }

  /**
   * RETURNING all columns.
   */
  returningAll(): TypedInsertReturningBuilder<DB, TB, SelectRow<DB, TB>> {
    const builder = new InsertBuilder({
      ...this._builder.build(),
      returning: [star()],
    })
    return new TypedInsertReturningBuilder(builder, this._printer, this._compile)
  }

  /**
   * Unified ON CONFLICT handler.
   *
   * Exactly one of `columns` or `constraint` is required — they correspond
   * to `ON CONFLICT (col, ...)` vs. `ON CONFLICT ON CONSTRAINT name`.
   * The `do` field picks the action:
   *
   * - `"nothing"` → `DO NOTHING`.
   * - `{ update: Partial<Insertable<DB[TB]>> }` → `DO UPDATE SET col = $N` (auto-parameterized values).
   * - `{ update: [{ column, value: Expression }] }` → raw Expression values.
   *
   * ```ts
   * // ON CONFLICT (email) DO NOTHING
   * .onConflict({ columns: ["email"], do: "nothing" })
   *
   * // ON CONFLICT (email) DO UPDATE SET name = $1
   * .onConflict({ columns: ["email"], do: { update: { name: "Alice Updated" } } })
   *
   * // ON CONFLICT ON CONSTRAINT users_email_key DO UPDATE SET name = expr
   * .onConflict({
   *   constraint: "users_email_key",
   *   do: { update: [{ column: "name", value: val("X") }] },
   * })
   * ```
   */
  onConflict(options: {
    columns?: (keyof DB[TB] & string)[]
    constraint?: string
    do:
      | "nothing"
      | {
          update:
            | Partial<Insertable<DB[TB]>>
            | { column: keyof DB[TB] & string; value: Expression<any> }[]
        }
  }): TypedInsertBuilder<DB, TB> {
    if ((options.columns == null) === (options.constraint == null)) {
      throw new Error(".onConflict() requires exactly one of `columns` or `constraint`.")
    }

    // DO NOTHING branch
    if (options.do === "nothing") {
      if (options.constraint) {
        return this._withBuilder(this._builder.onConflictConstraintDoNothing(options.constraint))
      }
      return this._withBuilder(this._builder.onConflictDoNothing(...options.columns!))
    }

    // DO UPDATE branch — normalize `update` to the `{column, value: ExpressionNode}[]` shape.
    const update = options.do.update
    let set: { column: string; value: ExpressionNode }[]
    if (Array.isArray(update)) {
      set = update.map((s) => ({ column: s.column, value: unwrap(s.value) }))
    } else {
      set = Object.entries(update as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([col, v]) => ({ column: col, value: param(0, v) }))
    }

    if (options.constraint) {
      return this._withBuilder(this._builder.onConflictConstraintDoUpdate(options.constraint, set))
    }
    return this._withBuilder(this._builder.onConflictDoUpdate(options.columns!, set))
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

  /** Compile to SQL using the full pipeline. */
  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this.build())
    if (!this._printer) {
      throw new Error(
        "toSQL() requires a printer. Use db.insertInto() or pass a printer to compile().",
      )
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

export class TypedInsertReturningBuilder<DB, _TB extends keyof DB, _R> {
  /** @internal */
  readonly _builder: InsertBuilder
  /** @internal */
  _printer?: Printer
  /** @internal */
  _compile?: (node: import("../ast/nodes.ts").ASTNode) => CompiledQuery

  constructor(
    builder: InsertBuilder,
    printer?: Printer,
    compile?: (node: import("../ast/nodes.ts").ASTNode) => CompiledQuery,
  ) {
    this._builder = builder
    this._printer = printer
    this._compile = compile
  }

  build(): InsertNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Run through the full compile pipeline (plugins, hooks, normalize, optimize, print). */
  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this.build())
    if (!this._printer) {
      throw new Error("toSQL() requires a printer. Use db.insertInto() to construct the builder.")
    }
    return this._printer.print(this.build())
  }
}
