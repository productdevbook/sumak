import type { ASTNode } from "../ast/nodes.ts"
import type { SumakExecutor } from "../driver/execute.ts"
import {
  listenerFor,
  resultTransformer,
  runExecute,
  runFirst,
  runOne,
  runQuery,
} from "../driver/execute.ts"
import { deriveResultContext } from "../plugin/result-context.ts"
import type { Printer } from "../printer/types.ts"
import type { CompiledQuery } from "../types.ts"
import type { CompiledQueryFn, CompiledRunners } from "./compiled.ts"
import { compileQuery } from "./compiled.ts"

/**
 * How a compiled query reaches the driver, built once from the AST it was
 * compiled from.
 *
 * The result context is derived here rather than per call. The uncompiled
 * helpers derive it every time and build the AST twice on the way — once for
 * the context and once inside `toSQL()` — which is the cost this whole layer
 * exists to remove.
 */
export function runnersFor<P extends Record<string, unknown>, Row>(
  executor: SumakExecutor,
  ast: ASTNode,
): (bind: (params: P) => CompiledQuery, statementName: string) => CompiledRunners<P, Row> {
  const ctx = deriveResultContext(ast)
  return (bind, statementName) => {
    // Carried on every call so the driver can keep the statement prepared. The
    // SQL text behind this name is fixed, so there is nothing to invalidate.
    const withName = (options?: { signal?: AbortSignal }) => ({ ...options, statementName })
    return {
      many: async (params, options) =>
        (await runQuery(
          executor.driver(),
          bind(params),
          resultTransformer(executor, ctx),
          withName(options),
          listenerFor(executor),
        )) as unknown as Row[],
      one: async (params, options) =>
        (await runOne(
          executor.driver(),
          bind(params),
          resultTransformer(executor, ctx),
          withName(options),
          listenerFor(executor),
        )) as unknown as Row,
      first: async (params, options) =>
        (await runFirst(
          executor.driver(),
          bind(params),
          resultTransformer(executor, ctx),
          withName(options),
          listenerFor(executor),
        )) as unknown as Row | null,
      run: async (params, options) =>
        (
          await runExecute(
            executor.driver(),
            bind(params),
            withName(options),
            listenerFor(executor),
          )
        ).affected,
    }
  }
}

/**
 * The two halves every builder repeats: compile an AST this builder already
 * produced, and hand back a compiled query wired to run.
 *
 * Extracted because it was written out nine times, and the ninth copy is where
 * the executor gets forgotten.
 */
export function compileNode(
  ast: ASTNode,
  entryPoint: string,
  printer: Printer | undefined,
  compile: ((node: ASTNode) => CompiledQuery) | undefined,
): CompiledQuery {
  if (compile) return compile(ast)
  if (!printer) {
    throw new Error(`toSQL() requires a printer. Use ${entryPoint} to construct the builder.`)
  }
  return printer.print(ast)
}

export function compiledFor<P extends Record<string, unknown>, Row>(
  ast: ASTNode,
  entryPoint: string,
  printer: Printer | undefined,
  compile: ((node: ASTNode) => CompiledQuery) | undefined,
  executor: SumakExecutor | undefined,
): CompiledQueryFn<P, Row> {
  if (!printer) {
    throw new Error(`toCompiled() requires a printer. Use ${entryPoint} to construct the builder.`)
  }
  return executor === undefined
    ? compileQuery<P, Row>(ast, printer, compile)
    : compileQuery<P, Row>(ast, printer, compile, runnersFor<P, Row>(executor, ast))
}
