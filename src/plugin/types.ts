import type { ASTNode } from "../ast/nodes.ts"

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
 * Plugin interface for sumak.
 *
 * Plugins can intercept at two points:
 * 1. transformNode — modify the AST before compilation (safe: structural guarantees preserved)
 * 2. transformResult — modify result rows after execution
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
}
