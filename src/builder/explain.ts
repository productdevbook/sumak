import type { ASTNode, ExplainNode } from "../ast/nodes.ts"
import type { SumakExecutor } from "../driver/execute.ts"
import { listenerFor, runQuery } from "../driver/execute.ts"
import type { Printer } from "../printer/types.ts"
import type { CompiledQuery } from "../types.ts"
import type { CompiledQueryFn } from "./compiled.ts"
import { compileQuery } from "./compiled.ts"

/**
 * Wraps a pre-built `ExplainNode` with the same builder surface
 * (`.build()` / `.compile(printer)` / `.toSQL()`) as every DML builder.
 * Returned from `.explain(...)` on SELECT/INSERT/UPDATE/DELETE builders
 * so callers don't have to destructure a bare `{ build, compile }` object.
 */
export class ExplainBuilder {
  /** @internal */
  readonly _node: ExplainNode
  /** @internal */
  readonly _printer?: Printer
  /** @internal */
  readonly _compile?: (node: ASTNode) => CompiledQuery
  /** @internal */
  readonly _executor?: SumakExecutor

  constructor(
    node: ExplainNode,
    printer?: Printer,
    compile?: (node: ASTNode) => CompiledQuery,
    executor?: SumakExecutor,
  ) {
    this._node = node
    this._printer = printer
    this._compile = compile
    this._executor = executor
  }

  /**
   * Run the EXPLAIN and return the plan.
   *
   * The rows are whatever the engine prints, which differs per dialect and per
   * option — `Record<string, unknown>` rather than a shape that would only be
   * right for one of them. Result plugins are deliberately not applied: a query
   * plan is not a row of your table.
   */
  async many(options?: { signal?: AbortSignal }): Promise<Record<string, unknown>[]> {
    if (!this._executor) {
      throw new Error(
        "explain().many() needs an instance to run against. " +
          "Build it from db.selectFrom(...).explain(...) so the driver is wired up.",
      )
    }
    return runQuery(
      this._executor.driver(),
      this.toSQL(),
      (rows) => rows,
      options,
      listenerFor(this._executor),
    )
  }

  build(): ExplainNode {
    return this._node
  }

  compile(printer: Printer): CompiledQuery {
    return printer.print(this._node)
  }

  toSQL(): CompiledQuery {
    if (this._compile) return this._compile(this._node)
    if (!this._printer) {
      throw new Error(
        "toSQL() requires a printer. Build the explain from db.selectFrom(...).explain(...).",
      )
    }
    return this._printer.print(this._node)
  }
  /**
   * Pre-compile the SQL with placeholders. See `TypedSelectBuilder.toCompiled()`.
   *
   * There is no executor behind this builder, so the compiled query carries the
   * SQL and fills parameters but cannot run itself.
   */
  toCompiled<P extends Record<string, unknown> = Record<string, unknown>>(): CompiledQueryFn<P> {
    if (!this._printer) {
      throw new Error("toCompiled() requires a printer. Use .explain() to construct the builder.")
    }
    return compileQuery<P>(this.build(), this._printer, this._compile)
  }
}
