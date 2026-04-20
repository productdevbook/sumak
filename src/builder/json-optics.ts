import type { ExpressionNode, JsonAccessNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { brandExpression } from "../ast/typed-expression.ts"

/**
 * JSON optics — composable, type-tracked JSON column navigation.
 *
 * Each `.at()` step creates a new optic that tracks the type at that level.
 * The final expression is a chain of JSON access operators.
 *
 * ```ts
 * // Type-tracked navigation:
 * jsonCol<UserProfile>("profile")
 *   .at("address")              // JsonOptic<Address>
 *   .at("city")                 // JsonOptic<string>
 *   .asText()                   // Expression<string>
 *
 * // Use in SELECT:
 * db.selectFrom("users")
 *   .select(jsonCol("data").at("name").asText().as("name"))
 * ```
 *
 * **Dialect-aware operators:**
 * - `.at("key")` → `->` (returns JSON)
 * - `.asText()` → `->>` (returns text)
 * - `.atPath("a.b.c")` → `#>` (PG path operator)
 * - `.asTextPath("a.b.c")` → `#>>` (PG text path operator)
 */
export class JsonOptic<T = unknown> {
  /** @internal */
  readonly _node: ExpressionNode
  declare readonly _type: T

  constructor(node: ExpressionNode) {
    this._node = node
  }

  /**
   * Navigate into a JSON object key. Returns JSON type.
   *
   * ```ts
   * jsonCol("data").at("address") // → data->'address'
   * ```
   */
  at<K extends string>(key: K): JsonOptic<T extends Record<K, infer V> ? V : unknown> {
    const node: JsonAccessNode = {
      type: "json_access",
      expr: this._node,
      path: key,
      operator: "->",
    }
    return new JsonOptic(node) as any
  }

  /**
   * Navigate into a JSON object key and extract as text.
   *
   * ```ts
   * jsonCol("data").text("name") // → data->>'name' (returns string)
   * ```
   */
  text<K extends string>(key: K): JsonExpr<string> {
    const node: JsonAccessNode = {
      type: "json_access",
      expr: this._node,
      path: key,
      operator: "->>",
    }
    return new JsonExpr<string>(node)
  }

  /**
   * Navigate by PG JSON path operator `#>`.
   *
   * ```ts
   * jsonCol("data").atPath("address.city") // → data#>'{address,city}'
   * ```
   */
  atPath(path: string): JsonOptic<unknown> {
    const node: JsonAccessNode = {
      type: "json_access",
      expr: this._node,
      path,
      operator: "#>",
    }
    return new JsonOptic(node)
  }

  /**
   * Navigate by PG JSON text path operator `#>>`.
   *
   * ```ts
   * jsonCol("data").textPath("address.city") // → data#>>'{address,city}'
   * ```
   */
  textPath(path: string): JsonExpr<string> {
    const node: JsonAccessNode = {
      type: "json_access",
      expr: this._node,
      path,
      operator: "#>>",
    }
    return new JsonExpr<string>(node)
  }

  /**
   * Cast current JSON value to text (`->>`).
   */
  asText(): JsonExpr<string> {
    // If current node is already a json_access with ->, convert to ->>
    if (this._node.type === "json_access") {
      const ja = this._node as JsonAccessNode
      if (ja.operator === "->") {
        return new JsonExpr<string>({ ...ja, operator: "->>" })
      }
    }
    // Otherwise, wrap as a cast
    return new JsonExpr<string>({
      type: "cast",
      expr: this._node,
      dataType: "text",
    })
  }

  /**
   * Get the underlying expression node as a branded Expression<T>.
   */
  toExpression(): Expression<T> {
    return brandExpression<T>(this._node)
  }
}

/**
 * A JSON expression that can be aliased and used in SELECT/WHERE.
 * This is the "leaf" of the optics chain.
 *
 * Implements `Expression<T>` at runtime: has a `.node` property and the
 * hidden `EXPRESSION_BRAND` symbol via a branded object, so
 * `.select({ alias: expr })` and `.set({ col: expr })` can pass it
 * directly through `isExpression()` + `unwrap()`.
 */
export class JsonExpr<T> implements Expression<T> {
  /** @internal legacy alias for node */
  readonly _node: ExpressionNode
  /** Node accessor that satisfies the `Expression<T>` interface. */
  readonly node: ExpressionNode
  declare readonly __type: T
  declare readonly _type: T

  constructor(node: ExpressionNode) {
    this._node = node
    this.node = node
    // Copy the runtime brand from a freshly-made Expression so
    // `isExpression(this)` returns true.
    Object.assign(this, brandExpression(node))
  }

  /**
   * Alias this expression for use in SELECT.
   *
   * ```ts
   * jsonCol("data").text("name").as("userName")
   * ```
   */
  as(alias: string): Expression<T> {
    if (this._node.type === "json_access") {
      return brandExpression<T>({ ...this._node, alias } as ExpressionNode)
    }
    return brandExpression<T>({
      type: "aliased_expr",
      expr: this._node,
      alias,
    } as ExpressionNode)
  }

  /**
   * Get the underlying expression node as a branded Expression<T>.
   */
  toExpression(): Expression<T> {
    return brandExpression<T>(this._node)
  }
}

/**
 * Create a JSON optic from a column name.
 *
 * ```ts
 * const profileCity = jsonCol<UserProfile>("profile").at("address").at("city").asText()
 * ```
 */
export function jsonCol<T = unknown>(column: string, table?: string): JsonOptic<T> {
  const node: ExpressionNode = { type: "column_ref", column, table }
  return new JsonOptic<T>(node)
}

/**
 * Create a JSON optic from an existing expression.
 *
 * ```ts
 * const optic = jsonExpr<Config>(someExpression).at("settings")
 * ```
 */
export function jsonExpr<T = unknown>(expr: Expression<any>): JsonOptic<T> {
  return new JsonOptic<T>((expr as any)._node ?? (expr as unknown as ExpressionNode))
}
