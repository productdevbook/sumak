import { param } from "../ast/expression.ts"
import type { ASTNode, ExpressionNode, MergeNode, SelectNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"
import type { Printer } from "../printer/types.ts"
import type { Insertable, Updateable } from "../schema/types.ts"
import type { CompiledQuery } from "../types.ts"
import { Col } from "./eb.ts"
import { MergeBuilder } from "./merge.ts"

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
  ) {
    this._targetTable = targetTable
    this._sourceAlias = sourceAlias
    this._printer = printer
    this._compile = compile
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
    const values = entries.map(([_, v]) => param(0, v))
    let condExpr: ExpressionNode | undefined
    if (condition) {
      const proxies = createMergeProxies<DB, Target, Source>(this._targetTable, this._sourceAlias)
      condExpr = unwrap(condition(proxies))
    }
    return this._with(this._builder.whenNotMatchedInsert(columns, values, condExpr))
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

  build(): MergeNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }

  /** Compile to SQL using the dialect's printer. */
  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this.build())
    if (!this._printer) {
      throw new Error("toSQL() requires a printer. Use db.mergeInto() to construct the builder.")
    }
    return this._printer.print(this.build())
  }
}
