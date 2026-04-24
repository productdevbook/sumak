import { and } from "../ast/expression.ts"
import type { ASTNode, DeleteNode, ExpressionNode, SelectNode, UpdateNode } from "../ast/nodes.ts"
import { QueryFlags } from "../ast/nodes.ts"
import { buildWhereNode, ForbiddenByCaslError } from "../casl/where.ts"
import type { AbilityLike } from "../casl/where.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * Config for {@link caslAuthz}.
 *
 * The plugin is DB-generic for typo protection on the `subjects` map:
 * `caslAuthz<DB>({ subjects: { postz: "Post" } })` fails to compile
 * when `postz` isn't a table in `DB`. Without the generic argument
 * the config still works (plain `Record<string, string>`), so ad-hoc
 * callers don't have to thread `DB` through every call site.
 *
 * ## What it does
 *
 * At AST-transform time, for every SELECT / UPDATE / DELETE whose
 * target table appears in {@link subjects}:
 *
 *   1. Look up the subject string (`posts` → `"Post"`).
 *   2. Walk `ability.rulesFor(mappedAction, subject)` and compose a
 *      ucast AST the same way CASL's own `rulesToAST` does (positive
 *      rules OR'd, inverted rules AND-NOT'd).
 *   3. If no rule matches (forbidden), throw
 *      {@link ForbiddenByCaslError} unless `onForbidden: "empty"` is
 *      set — then inject `WHERE FALSE` instead.
 *   4. Otherwise, convert the ucast tree to a sumak
 *      {@link ExpressionNode} and AND it into the existing WHERE.
 *
 * No CASL import required at the sumak side — we depend on the
 * structural `ability.rulesFor(...)` contract, which is stable across
 * every `@casl/ability` version since 5.x. See the `where.ts`
 * docstring for the reasoning behind not calling `rulesToAST` from
 * `@casl/ability/extra` directly (TypeScript generic variance).
 *
 * ## What it deliberately does NOT do
 *
 *   - **INSERT.** Validating an INSERT's `values` against CASL's
 *     conditions is a footgun: conditions can reference columns the
 *     caller didn't set (server-generated defaults, trigger-set
 *     values), leading to false positives (block a valid insert) or
 *     false negatives (silently allow an unauthorized one). Use
 *     `multiTenant` to inject tenant columns, or verify inserts
 *     application-side with `ability.can('create', subject(...))`.
 *     @casl/prisma's `accessibleBy` makes the same choice.
 *   - **Field-level permit/forbid.** `permittedFieldsOf` support
 *     (prune SELECT columns, strip UPDATE SET keys) is intentionally
 *     out of v1 — it needs schema introspection to expand `SELECT *`,
 *     which the plugin layer doesn't have. Planned for a later pass.
 *
 * ## Ordering with other plugins
 *
 * Register `caslAuthz` **before** `multiTenant`: authz filters rows
 * first, tenancy narrows them further. The observable SQL is
 * `WHERE casl_where AND tenant_id = ?`. Reversing the order still
 * produces semantically equivalent SQL, but the intuitive layering
 * (authz → tenancy → business) is lost. The two plugins use
 * separate idempotency flags
 * ({@link QueryFlags.CaslAuthzApplied} and
 * {@link QueryFlags.MultiTenantApplied}) so recursive traversal of
 * nested SELECTs doesn't double-apply either filter.
 */
export interface CaslAuthzConfig<DB = Record<string, unknown>> {
  /**
   * CASL ability instance. Anything with a `rulesFor(action, subject)`
   * method works — `PureAbility`, `MongoAbility`, `Ability`, and the
   * various framework-specific ones (casl-prisma, casl-mongoose) all
   * satisfy this shape.
   */
  readonly ability: AbilityLike
  /**
   * Table-name → CASL-subject-string map. Only tables listed here are
   * authz-filtered; everything else passes through untouched.
   */
  readonly subjects: Readonly<{ [K in keyof DB & string]?: string }>
  /**
   * SQL statement kind → CASL action name. Defaults:
   *   { select: "read", update: "update", delete: "delete" }
   * Override per-verb when your CASL rules use non-standard action
   * names (e.g. `"view"` instead of `"read"`).
   */
  readonly actions?: {
    readonly select?: string
    readonly update?: string
    readonly delete?: string
  }
  /**
   * What to do when the ability has no matching rule for a table in
   * `subjects`:
   *
   *   - `"throw"` (default): throw {@link ForbiddenByCaslError} at
   *     compile time. Matches `@casl/prisma` semantics. Safer —
   *     silent authz failures are classic bugs.
   *   - `"empty"`: inject `WHERE FALSE`; the query succeeds with
   *     zero rows. Matches Postgres RLS semantics. Useful when you
   *     specifically want the "is there anything visible at all?"
   *     question to return a clean empty set.
   */
  readonly onForbidden?: "throw" | "empty"
}

/**
 * AST-rewriting plugin that enforces a CASL {@link AbilityLike}
 * against every SELECT / UPDATE / DELETE on a mapped table. See
 * {@link CaslAuthzConfig} for the full contract.
 *
 * ```ts
 * import { caslAuthz } from "sumak"
 *
 * const db = sumak({
 *   dialect: pgDialect(),
 *   tables,
 *   plugins: [
 *     caslAuthz({
 *       ability,
 *       subjects: { posts: "Post", users: "User" },
 *       onForbidden: "throw",
 *     }),
 *     // Register multi-tenant AFTER caslAuthz — authz first, tenancy
 *     // narrows further.
 *     multiTenant({ tables: ["posts", "users"], tenantId: () => ctx.tenantId }),
 *   ],
 * })
 *
 * // Now every SELECT on `posts` silently picks up the CASL WHERE.
 * const rows = await db.selectFrom("posts").many()
 * // → SELECT ... FROM posts WHERE (casl-derived) AND tenant_id = ?
 * ```
 */
export function caslAuthz<DB = Record<string, unknown>>(config: CaslAuthzConfig<DB>): SumakPlugin {
  const subjects = config.subjects as Readonly<Record<string, string | undefined>>
  const selectAction = config.actions?.select ?? "read"
  const updateAction = config.actions?.update ?? "update"
  const deleteAction = config.actions?.delete ?? "delete"
  const onForbidden = config.onForbidden ?? "throw"

  // Resolve the CASL-derived WHERE for a table + action. Returns
  // `undefined` when the table isn't in `subjects` (pass-through) or
  // when the rule tree collapses to TRUE (unconditional can — also
  // pass-through, no need to AND `TRUE`). For forbidden we either
  // throw (default) or inject `literal(false)` depending on
  // `onForbidden`.
  function whereFor(table: string, action: string): ExpressionNode | undefined {
    const subject = subjects[table]
    if (subject === undefined) return undefined
    const node = buildWhereNode(config.ability, action, subject)
    if (node === null) {
      if (onForbidden === "empty") {
        // WHERE FALSE — the executor runs a real query that returns
        // zero rows. Matches Postgres RLS; authorized callers
        // opt into this explicitly via the config flag.
        return { type: "literal", value: false }
      }
      throw new ForbiddenByCaslError(action, subject)
    }
    // Tautological TRUE (unconditional `can`) → pass-through. The
    // optimizer would strip `AND TRUE` anyway but keeping it out of
    // the AST keeps debug output clean.
    if (node.type === "literal" && node.value === true) return undefined
    return node
  }

  function andInto(existing: ExpressionNode | undefined, extra: ExpressionNode): ExpressionNode {
    return existing ? and(existing, extra) : extra
  }

  function transformSelect(node: SelectNode): SelectNode {
    const flags = node.flags ?? 0
    if (flags & QueryFlags.CaslAuthzApplied) return node
    // Only direct table FROMs are authz-targeted. Subqueries route
    // through the PluginManager's recursive walk, so their inner
    // SELECT gets its own chain pass.
    if (!node.from || node.from.type !== "table_ref") {
      return { ...node, flags: flags | QueryFlags.CaslAuthzApplied }
    }
    const caslWhere = whereFor(node.from.name, selectAction)
    if (!caslWhere) {
      return { ...node, flags: flags | QueryFlags.CaslAuthzApplied }
    }
    return {
      ...node,
      where: andInto(node.where, caslWhere),
      flags: flags | QueryFlags.CaslAuthzApplied,
    }
  }

  function transformUpdate(node: UpdateNode): UpdateNode {
    const flags = node.flags ?? 0
    if (flags & QueryFlags.CaslAuthzApplied) return node
    const caslWhere = whereFor(node.table.name, updateAction)
    if (!caslWhere) {
      return { ...node, flags: flags | QueryFlags.CaslAuthzApplied }
    }
    return {
      ...node,
      where: andInto(node.where, caslWhere),
      flags: flags | QueryFlags.CaslAuthzApplied,
    }
  }

  function transformDelete(node: DeleteNode): DeleteNode {
    const flags = node.flags ?? 0
    if (flags & QueryFlags.CaslAuthzApplied) return node
    const caslWhere = whereFor(node.table.name, deleteAction)
    if (!caslWhere) {
      return { ...node, flags: flags | QueryFlags.CaslAuthzApplied }
    }
    return {
      ...node,
      where: andInto(node.where, caslWhere),
      flags: flags | QueryFlags.CaslAuthzApplied,
    }
  }

  return {
    name: "caslAuthz",
    transformNode(node: ASTNode): ASTNode {
      switch (node.type) {
        case "select":
          return transformSelect(node)
        case "update":
          return transformUpdate(node)
        case "delete":
          return transformDelete(node)
        // INSERT and MERGE are intentionally untouched. See the
        // CaslAuthzConfig docstring for the rationale.
        default:
          return node
      }
    },
  }
}
