import type {
  ASTNode,
  ExpressionNode,
  InsertNode,
  MergeNode,
  ParamNode,
  UpdateNode,
} from "../ast/nodes.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * Built-in transformation tags. Each maps to a deterministic string→string
 * (or string→null, for `emptyToNull`) rewrite that runs once per value.
 *
 * Custom hooks are also welcome — pass a `(value: string) => string | null`
 * in place of (or alongside) the built-ins.
 */
export type NormalizeTransform =
  | "lower"
  | "upper"
  | "trim"
  | "trimStart"
  | "trimEnd"
  | "emptyToNull"
  | "collapseWhitespace"
  | ((value: string) => string | null)

/**
 * Per-column rewrite spec. Either a single transform or an ordered list;
 * the list is applied left-to-right, so `["trim", "lower"]` trims first
 * and lowercases the result.
 */
export type NormalizeTransformSpec = NormalizeTransform | NormalizeTransform[]

/**
 * Plugin config: `{ [table]: { [column]: spec } }`.
 *
 * Unconfigured tables and columns are pass-through. Non-string values
 * (numbers, booleans, null) flow through untouched even on configured
 * columns — the plugin is deliberately defensive: the type checker
 * already prevents mismatched value types in user code, so the runtime
 * skip is just a safety net for `as any` escapes / dynamic input.
 */
export type NormalizeStringsConfig = Readonly<
  Record<string, Readonly<Record<string, NormalizeTransformSpec>>>
>

/**
 * Apply one transform to a string. `emptyToNull` is the only built-in
 * that may produce `null` — every other transform returns a string. A
 * custom function may also return `null` to signal "treat as SQL NULL".
 */
function applyTransform(value: string, transform: NormalizeTransform): string | null {
  if (typeof transform === "function") return transform(value)
  switch (transform) {
    case "lower":
      return value.toLowerCase()
    case "upper":
      return value.toUpperCase()
    case "trim":
      return value.trim()
    case "trimStart":
      return value.trimStart()
    case "trimEnd":
      return value.trimEnd()
    case "emptyToNull":
      return value === "" ? null : value
    case "collapseWhitespace":
      // Multiple consecutive whitespace chars collapse to a single space.
      // Uses Unicode whitespace class — same characters `String#trim`
      // strips — so the two transforms compose intuitively.
      return value.replace(/\s+/g, " ")
  }
}

/**
 * Run the configured transform list against `value`. The first
 * transform that produces `null` short-circuits the rest — a chained
 * `[..., "emptyToNull", "lower"]` is well-defined: once the value is
 * null, no further string transforms run.
 */
function runTransforms(value: string, spec: NormalizeTransformSpec): string | null {
  const list = Array.isArray(spec) ? spec : [spec]
  let current: string | null = value
  for (const t of list) {
    if (current === null) return null
    current = applyTransform(current, t)
  }
  return current
}

/**
 * Replace the inline value of a ParamNode with the normalized one,
 * preserving the original index so the parameter numbering the printer
 * emits stays consistent. Returns the input unchanged when the value
 * isn't a non-null string.
 */
function rewriteParam(node: ParamNode, spec: NormalizeTransformSpec): ParamNode {
  if (typeof node.value !== "string") return node
  const next = runTransforms(node.value, spec)
  if (next === node.value) return node
  return { ...node, value: next }
}

/**
 * Plugin that auto-normalises string column values on INSERT / UPDATE /
 * MERGE per a per-column configuration.
 *
 * The rewrite runs at the *value* layer, not the SQL layer: configured
 * `ParamNode`s in the AST get their `.value` swapped before the printer
 * sees them. The generated SQL is identical to what you'd get without
 * the plugin (no `LOWER(?)` wrapping), keeping it dialect-portable and
 * indexable.
 *
 * ```ts
 * import { normalizeStrings } from "sumak"
 *
 * const db = sumak({
 *   dialect: pgDialect(),
 *   tables: { users },
 *   plugins: [
 *     normalizeStrings({
 *       users: {
 *         email: ["trim", "lower"],
 *         name:  "trim",
 *         bio:   ["trim", "emptyToNull"],
 *       },
 *     }),
 *   ],
 * })
 *
 * db.insertInto("users")
 *   .values({ email: "  Alice@Example.com  ", name: "Alice  ", bio: "  " })
 *   .toSQL()
 * // INSERT INTO "users" ("email", "name", "bio") VALUES ($1, $2, $3)
 * // params: ["alice@example.com", "Alice", null]
 * ```
 *
 * Transformations: `"lower"`, `"upper"`, `"trim"`, `"trimStart"`,
 * `"trimEnd"`, `"emptyToNull"`, `"collapseWhitespace"`, plus arbitrary
 * `(value: string) => string | null` custom functions.
 */
export function normalizeStrings(config: NormalizeStringsConfig): SumakPlugin {
  // Normalise the config to a Map<table, Map<column, spec>> so per-row
  // lookups are O(1) regardless of how the user typed the object out.
  const tables = new Map<string, Map<string, NormalizeTransformSpec>>()
  for (const [table, cols] of Object.entries(config)) {
    const m = new Map<string, NormalizeTransformSpec>()
    for (const [col, spec] of Object.entries(cols)) {
      m.set(col, spec)
    }
    tables.set(table, m)
  }

  /**
   * Rewrite a single ExpressionNode in-place-of: if it's a string-valued
   * ParamNode under a configured column, return the normalised
   * replacement; otherwise pass the original through. Non-ParamNode
   * expressions (CURRENT_TIMESTAMP function call, sub-SELECT, column
   * reference for `col = other_col` updates, …) are left alone — the
   * plugin only rewrites *literal* string values supplied by the user.
   */
  function rewriteValue(
    value: ExpressionNode,
    spec: NormalizeTransformSpec | undefined,
  ): ExpressionNode {
    if (!spec) return value
    if (value.type !== "param") return value
    return rewriteParam(value, spec)
  }

  function transformInsert(node: InsertNode): InsertNode {
    const cols = tables.get(node.table.name)
    if (!cols) return node
    if (node.columns.length === 0 || node.values.length === 0) return node

    // The per-column spec is sparse — most columns have no rewrite.
    // Build a parallel array of specs once per query, indexed by the
    // INSERT column position, so the per-row loop just does a lookup.
    const specs: (NormalizeTransformSpec | undefined)[] = node.columns.map((c) => cols.get(c))
    if (specs.every((s) => s === undefined)) return node

    const values = node.values.map((row) => row.map((v, i) => rewriteValue(v, specs[i])))
    return { ...node, values }
  }

  function transformUpdate(node: UpdateNode): UpdateNode {
    const cols = tables.get(node.table.name)
    if (!cols) return node
    if (node.set.length === 0) return node

    let changed = false
    const set = node.set.map((s) => {
      const spec = cols.get(s.column)
      if (!spec) return s
      const next = rewriteValue(s.value, spec)
      if (next === s.value) return s
      changed = true
      return { ...s, value: next }
    })
    return changed ? { ...node, set } : node
  }

  function transformMerge(node: MergeNode): MergeNode {
    const cols = tables.get(node.target.name)
    if (!cols) return node
    let changed = false
    const whens = node.whens.map((w) => {
      if (w.type === "not_matched") {
        if (w.columns.length === 0) return w
        const specs: (NormalizeTransformSpec | undefined)[] = w.columns.map((c) => cols.get(c))
        if (specs.every((s) => s === undefined)) return w
        const values = w.values.map((v, i) => rewriteValue(v, specs[i]))
        // Mutation-free identity check — if every slot returned the
        // input reference, nothing changed and we can keep the
        // original.
        const any = values.some((v, i) => v !== w.values[i])
        if (!any) return w
        changed = true
        return { ...w, values }
      }
      if ((w.type === "matched" || w.type === "not_matched_by_source") && w.action === "update") {
        const existing = w.set
        if (!existing || existing.length === 0) return w
        let localChanged = false
        const next = existing.map((s) => {
          const spec = cols.get(s.column)
          if (!spec) return s
          const v = rewriteValue(s.value, spec)
          if (v === s.value) return s
          localChanged = true
          return { ...s, value: v }
        })
        if (!localChanged) return w
        changed = true
        return { ...w, set: next }
      }
      return w
    })
    return changed ? { ...node, whens } : node
  }

  return {
    name: "normalize-strings",
    transformNode(node: ASTNode): ASTNode {
      switch (node.type) {
        case "insert":
          return transformInsert(node)
        case "update":
          return transformUpdate(node)
        case "merge":
          return transformMerge(node)
        default:
          return node
      }
    },
  }
}
