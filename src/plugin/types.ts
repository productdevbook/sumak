import type { ASTNode } from "../ast/nodes.ts"
import type { OnQueryListener } from "../driver/types.ts"
import type { HookName, SumakHooks } from "./hooks.ts"

/**
 * Context accompanying a `transformResult` call. Lets plugins that
 * enrich rows (issue #90 / CASL `__typename`, RLS tagging, column-level
 * masking, …) know which query the rows came from — the source AST and
 * an optional column→table map resolved from the query's SELECT list.
 *
 * The map is keyed by the column's output name (alias if present, else
 * column name). Values are the table the column projects from, when
 * that can be determined unambiguously. Columns from expressions
 * (function calls, literals, computed aliases) or ambiguous joins
 * without an explicit `table.col` reference are omitted.
 *
 * All fields are optional — older `transformResult(rows)` signatures
 * keep working without change.
 */
export interface ResultContext {
  /** The compiled root node (SELECT / INSERT … RETURNING / …). */
  node?: ASTNode
  /** The primary target table name, if the AST had one (FROM / INTO / UPDATE / DELETE). */
  table?: string
  /**
   * Column → source-table map derived from the query's output columns.
   * Present for SELECT statements and for DML with RETURNING.
   */
  columnSources?: Readonly<Record<string, string>>
}

/**
 * One-time setup API handed to {@link SumakPlugin.setup}. Lets a plugin
 * register lifecycle hooks (`query:after`, `select:before`, …) and
 * additional `onQuery` observers without pinning a reference to the
 * full `Sumak` instance (which would create an import cycle for plugins
 * that live below the core in the build graph).
 *
 * Listeners passed to `addOnQuery` are chained alongside the listener
 * configured via `sumak({ onQuery })`; sumak invokes each listener
 * exactly once per query event and swallows their thrown errors (so an
 * observability bug can't take down a query).
 */
export interface SumakPluginSetupContext {
  /** Register a lifecycle hook. Returns an unregister function. */
  hook<K extends HookName>(name: K, handler: SumakHooks[K]): () => void
  /** Append an extra `onQuery` listener. Fires after the user-provided one. */
  addOnQuery(listener: OnQueryListener): void
}

/**
 * Plugin interface for sumak.
 *
 * Plugins can intercept at three points:
 * 1. transformNode — modify the AST before compilation (safe: structural guarantees preserved)
 * 2. transformResult — modify result rows after execution
 * 3. setup — register lifecycle hooks or extra `onQuery` observers once
 *    at construction (for plugins that observe rather than rewrite)
 *
 * **Security note:** `transformQuery` was removed because it allowed plugins to modify
 * compiled SQL strings directly, bypassing parameterization and enabling injection.
 * Use `transformNode` to modify queries at the AST level instead.
 */
export interface SumakPlugin {
  readonly name: string

  /** Transform AST before compilation. Return a new node (never mutate). */
  transformNode?(node: ASTNode): ASTNode

  /**
   * Transform result rows after execution. The second parameter carries
   * AST context (source table, per-column table map). It's optional on
   * the caller side, so plugins using the old `(rows) => rows` shape
   * still work.
   */
  transformResult?(rows: Record<string, unknown>[], ctx?: ResultContext): Record<string, unknown>[]

  /**
   * Called once per `Sumak` instance, right after the plugin pipeline
   * is wired up. Used by observer-style plugins (debug logger, custom
   * metrics) that need to attach hooks or extra `onQuery` listeners
   * without exposing a separate registration API.
   *
   * Plugins that only need `transformNode` / `transformResult` can
   * leave this unimplemented.
   */
  setup?(api: SumakPluginSetupContext): void
}
