/**
 * SQL:2023 Part 16 (SQL/PGQ) Property Graph Queries AST nodes.
 *
 * **Spike status.** This is the minimum viable surface for emitting
 * `FROM GRAPH_TABLE (...)` in standard SQL:2023 and
 * `FROM cypher('graph', $$...$$) AS (col agtype, ...)` in Apache AGE.
 *
 * The MATCH pattern is stored opaquely as a string — parsing Cypher-ish
 * graph patterns is deferred (see /tmp/pgq-spike.md §5 "Out of scope").
 * Interpolated values flow through the normal `params` pipeline, so
 * tagged-template usage remains SQL-injection-safe.
 *
 * ```sql
 * -- SQL:2023 form (Oracle 23ai, PG 18+):
 * SELECT ... FROM GRAPH_TABLE (social_graph
 *   MATCH (p:Person)-[:FOLLOWS]->(f:Person)
 *   WHERE p.name = 'Alice'
 *   COLUMNS (p.name, f.name)
 * ) AS g
 *
 * -- Apache AGE form (PG extension, the reality today):
 * SELECT ... FROM cypher('social_graph', $$
 *   MATCH (p:Person)-[:FOLLOWS]->(f:Person)
 *   WHERE p.name = 'Alice'
 *   RETURN p.name, f.name
 * $$) AS g(name1 agtype, name2 agtype)
 * ```
 */

import type { ExpressionNode } from "./nodes.ts"

/**
 * Opaque graph pattern — a Cypher-ish MATCH body stored as a literal
 * string with parameterized substitutions. We don't parse it; we just
 * forward it to the printer, which routes it into the correct syntax
 * for the active dialect (GRAPH_TABLE or AGE `cypher()`).
 *
 * `paramValues` items substitute into the `pattern` string wherever the
 * printer finds the placeholder token (see `GraphTableBuilder.match`).
 * They are routed through the regular param pipeline — `$1`/`?`/`@p0`.
 */
export interface GraphPatternNode {
  type: "graph_pattern"
  pattern: string
  paramValues: unknown[]
}

/**
 * A column projected from a graph table. `expr` is an opaque pattern-
 * language expression string like `"p.name"` or `"VERTEX_ID(v)"` — the
 * SQL/PGQ COLUMNS clause and the AGE RETURN clause both accept these as
 * bare column references over the pattern variables. `alias` is the
 * output column name visible to the surrounding SELECT.
 */
export interface GraphColumnNode {
  type: "graph_column"
  /** e.g. "p.name", "VERTEX_ID(v)" — passed through verbatim. */
  expr: string
  alias?: string
}

/**
 * Top-level graph-table node that appears in `SelectNode.from`.
 */
export interface GraphTableNode {
  type: "graph_table"
  /** Name of the (already-created) property graph. */
  graph: string
  /** MATCH pattern — opaque string + paramValues. */
  match: GraphPatternNode
  /** Optional top-level WHERE over pattern variables. */
  where?: ExpressionNode
  /** COLUMNS list — what to project out of the graph table. */
  columns: GraphColumnNode[]
  /** Alias for the resulting table. */
  alias?: string
}
