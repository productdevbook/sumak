import type { GraphColumnNode, GraphPatternNode, GraphTableNode } from "../ast/graph-nodes.ts"
import type { ExpressionNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { unwrap } from "../ast/typed-expression.ts"

/**
 * Marker substitution token used inside `GraphPatternNode.pattern` to
 * indicate a parameter boundary. The printer replaces these at emit time
 * with dialect-specific placeholders (`$1`, `?`, `@p0`). Not a valid
 * Cypher identifier so won't collide with real pattern text.
 */
export const GRAPH_PARAM_TOKEN = "\x00SUMAK_GRAPH_PARAM\x00"

/**
 * Builder for `FROM GRAPH_TABLE(...)` / `FROM cypher(...)` clauses —
 * the SQL:2023 Part 16 property-graph query form.
 *
 * **Spike status.** See `/tmp/pgq-spike.md` for the full design. This
 * builder handles the single-pattern case; multi-pattern joins,
 * quantifiers, and path variables are deferred.
 *
 * ```ts
 * const g = db.graphTable("social_graph")
 *   .match`(p:Person)-[:FOLLOWS]->(f:Person) WHERE p.name = ${"Alice"}`
 *   .columns({ follower: "p.name", followee: "f.name" })
 *   .as("g")
 *
 * // Use as a subquery source in SELECT:
 * db.selectFromGraph(g).select("follower", "followee").toSQL()
 * ```
 *
 * Standard SQL:2023 emits `FROM GRAPH_TABLE(social_graph MATCH ... COLUMNS (...))`.
 * PostgreSQL + Apache AGE emits `FROM cypher('social_graph', $$...$$) AS g(...)`.
 */
export class GraphTableBuilder {
  /** @internal */
  readonly _node: GraphTableNode

  constructor(node: GraphTableNode) {
    this._node = node
  }

  /**
   * Provide the MATCH pattern as a tagged-template literal. Any
   * interpolated values are routed through the normal param pipeline;
   * the pattern string itself is kept opaque — we do not parse it.
   *
   * ```ts
   * .match`(p:Person)-[:FOLLOWS]->(f:Person) WHERE p.name = ${userName}`
   * ```
   */
  match(strings: TemplateStringsArray, ...values: unknown[]): GraphTableBuilder {
    // Stitch the string pieces together, inserting placeholders at each
    // interpolation boundary. The printer will swap in real param refs.
    let pattern = strings[0] ?? ""
    const paramValues: unknown[] = []
    for (let i = 0; i < values.length; i++) {
      paramValues.push(values[i])
      pattern += GRAPH_PARAM_TOKEN + (strings[i + 1] ?? "")
    }
    const matchNode: GraphPatternNode = { type: "graph_pattern", pattern, paramValues }
    return new GraphTableBuilder({ ...this._node, match: matchNode })
  }

  /**
   * Top-level WHERE over pattern variables, translated into SQL:2023's
   * GRAPH_TABLE `WHERE` or AGE's Cypher `WHERE`. Prefer inline WHERE
   * inside the match pattern when filtering on a single element; use
   * this for cross-element joins.
   */
  where(expr: Expression<boolean>): GraphTableBuilder {
    return new GraphTableBuilder({ ...this._node, where: unwrap(expr) })
  }

  /**
   * COLUMNS clause. Pass an object mapping output column alias → pattern
   * expression. The pattern expressions (e.g. `"p.name"`) are opaque —
   * passed through verbatim. If you need a dynamic expression, keep it
   * out of the graph table and use it in the outer SELECT.
   *
   * ```ts
   * .columns({ follower: "p.name", followee: "f.name" })
   * ```
   */
  columns(aliased: Record<string, string>): GraphTableBuilder {
    const cols: GraphColumnNode[] = Object.entries(aliased).map(([alias, expr]) => ({
      type: "graph_column",
      expr,
      alias,
    }))
    if (cols.length === 0) {
      throw new Error(".columns({}) requires at least one projected column.")
    }
    return new GraphTableBuilder({ ...this._node, columns: cols })
  }

  /** Alias the graph table for use in the surrounding SELECT. */
  as(alias: string): GraphTableBuilder {
    return new GraphTableBuilder({ ...this._node, alias })
  }

  /** Return the underlying AST node. */
  build(): GraphTableNode {
    if (this._node.columns.length === 0) {
      throw new Error(".build() on a GraphTableBuilder requires at least one .columns() entry.")
    }
    if (!this._node.match || this._node.match.pattern.length === 0) {
      throw new Error(".build() on a GraphTableBuilder requires a .match`...` pattern.")
    }
    return this._node
  }
}

/** Factory for use from `db.graphTable(name)`. */
export function graphTable(name: string): GraphTableBuilder {
  const empty: GraphTableNode = {
    type: "graph_table",
    graph: name,
    match: { type: "graph_pattern", pattern: "", paramValues: [] },
    columns: [],
  }
  return new GraphTableBuilder(empty)
}

// Silence unused-import lint (we re-export the type internally).
void ({} as ExpressionNode | undefined)
