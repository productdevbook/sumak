import { param } from "../ast/expression.ts"
import type { ExpressionNode, MergeNode, SelectNode } from "../ast/nodes.ts"
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
  private _targetTable: Target & string
  private _sourceAlias: string

  constructor(
    targetTable: Target & string,
    sourceTable: Source & string,
    sourceAlias: string,
    on: Expression<boolean>,
  ) {
    this._targetTable = targetTable
    this._sourceAlias = sourceAlias
    this._builder = new MergeBuilder()
      .into(targetTable)
      .using(sourceTable, sourceAlias)
      .on(unwrap(on))
  }

  /** @internal */
  private _with(builder: MergeBuilder): TypedMergeBuilder<DB, Target, Source> {
    const t = new TypedMergeBuilder<DB, Target, Source>("" as any, "" as any, "", {
      node: { type: "literal", value: true },
    } as any)
    ;(t as any)._builder = builder
    ;(t as any)._targetTable = this._targetTable
    ;(t as any)._sourceAlias = this._sourceAlias
    return t
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

  with(
    name: string,
    query: SelectNode,
    options?: { recursive?: boolean },
  ): TypedMergeBuilder<DB, Target, Source> {
    return this._with(this._builder.with(name, query, options?.recursive === true))
  }

  build(): MergeNode {
    return this._builder.build()
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this.build())
  }
}
