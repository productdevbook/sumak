import type { ASTNode, ExplainNode } from "../ast/nodes.ts"
import type { Printer } from "../printer/types.ts"
import type { CompiledQuery } from "../types.ts"

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

  constructor(node: ExplainNode, printer?: Printer, compile?: (node: ASTNode) => CompiledQuery) {
    this._node = node
    this._printer = printer
    this._compile = compile
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
}
