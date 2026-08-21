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
import type { CompiledQuery } from "../types.ts"
import type { CompiledRunners } from "./compiled.ts"

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
