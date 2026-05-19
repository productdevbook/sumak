import type { ASTNode, ExpressionNode, InsertNode, UpdateNode } from "../ast/nodes.ts"
import { ValidationError } from "../errors.ts"
import type { SumakPlugin } from "./types.ts"

/**
 * A per-column validator predicate.
 *
 * Receives the value the user supplied for the column on this row.
 * Return:
 *  - `true` (or any truthy value) → valid, run the next validator.
 *  - `false` → invalid, throw with a default `"invalid value"` message.
 *  - `string` → invalid, throw with the returned message.
 *
 * The validator can short-circuit on `null` if it wants (e.g.
 * `if (value === null) return true`) — by default the plugin runs
 * validators against every literal value, including JS `null`.
 */
export type Validator = (value: unknown) => true | string | false

/**
 * Plugin config: `{ [table]: { [column]: validator | validator[] } }`.
 *
 * Tables not present in the config are pass-through. Columns not present
 * in a configured table's map are pass-through. A single validator or an
 * array is accepted — when an array is given, validators run in
 * declaration order and the first failure wins (later validators do not
 * run).
 */
export type ValidatorsConfig = Readonly<
  Record<string, Readonly<Record<string, Validator | Validator[]>>>
>

/**
 * Materialise a single failure into a {@link ValidationError}. The
 * validator's return value tells us the message: a non-empty string is
 * used verbatim, `false` falls back to `"invalid value"`.
 */
function failure(
  table: string,
  column: string,
  value: unknown,
  result: false | string,
): ValidationError {
  const message = typeof result === "string" && result.length > 0 ? result : "invalid value"
  return new ValidationError({ table, column, value, message })
}

/**
 * Run a column's validator list against `value`. The first failure
 * throws — later validators do not run, mirroring the "fail fast"
 * convention from `normalizeStrings`' transform chain.
 */
function runValidators(
  table: string,
  column: string,
  value: unknown,
  validators: Validator[],
): void {
  for (const v of validators) {
    const r = v(value)
    if (r === true) continue
    // Truthy non-`true` (e.g. `1`, `"ok"` if the user wrote a weird
    // predicate) — we treat anything that isn't strictly `false` or a
    // string-error as success. The most common shape is `predicate ||
    // "msg"`, which yields `true` on success and a string on failure,
    // so a truthy-non-true here is almost certainly a user bug. We err
    // on the side of "pass" to avoid raising on a buggy validator;
    // the `string` message form is the explicit failure channel.
    if (r === false || typeof r === "string") {
      throw failure(table, column, value, r)
    }
  }
}

/**
 * Plugin that runs per-column validator predicates against literal
 * values supplied to INSERT and UPDATE statements. Fires before the
 * query reaches the database — invalid input is rejected with a clear
 * {@link ValidationError} at compile time, not after a round trip.
 *
 * Complements {@link normalizeStrings} (which *transforms* values) and
 * {@link defaults} (which *injects* values): `validators` is the one
 * that *rejects* them. Use it for assertions you'd otherwise write as a
 * CHECK constraint when you want the error surfaced in JS-land before
 * the DB sees the row.
 *
 * ```ts
 * import { sumak, validators, ValidationError, pgDialect } from "sumak"
 *
 * const db = sumak({
 *   dialect: pgDialect(),
 *   tables: { users },
 *   plugins: [
 *     validators({
 *       users: {
 *         email: [
 *           (v) => (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || "invalid email",
 *           (v) => (typeof v === "string" && v.length <= 255) || "email too long",
 *         ],
 *         age: [
 *           (v) => (typeof v === "number" && v >= 0 && v <= 150) || "age out of range",
 *         ],
 *       },
 *     }),
 *   ],
 * })
 *
 * // Throws ValidationError("users.email: invalid email") at toSQL()/compile time.
 * db.insertInto("users").values({ email: "not-an-email" }).toSQL()
 * ```
 *
 * Behaviour rules:
 *
 * - **INSERT and UPDATE** are validated. SELECT / DELETE / MERGE pass
 *   through — there's no user-supplied write value to assert against on
 *   the read path, and MERGE's tuple-and-set surface is rich enough that
 *   we'd rather not silently apply different rules across its branches.
 * - **One row at a time**: every row in an `INSERT … VALUES (…), (…)` is
 *   validated independently. The first row that fails throws — the
 *   remaining rows are not consulted.
 * - **Declaration order wins**: for a column with multiple validators,
 *   the array is iterated left-to-right. The first failure throws and
 *   later validators do not run. This lets users put cheap "type guard"
 *   checks before expensive regex checks.
 * - **Unconfigured columns are pass-through**: only columns named in the
 *   config are checked. Sneaking past the type checker (e.g. via
 *   `values({ ...obj, oddCol: 1 } as any)`) on an unconfigured column
 *   bypasses validation — by design, the plugin is opt-in per column.
 * - **Non-`ParamNode` values pass through**: a `set({ updated_at: now()
 *   })` or a sub-`SELECT` value can't be statically inspected, so the
 *   plugin won't fire. Users who need that level of guarantee should
 *   keep the assertion at the DB layer (CHECK constraint / trigger).
 * - **`null` values are surfaced to the validator**: by default, a
 *   `values({ email: null })` will hand `null` to the validators
 *   verbatim. Callers can opt-out per validator with an early
 *   `return true` on `value === null`.
 */
export function validators(config: ValidatorsConfig): SumakPlugin {
  // Pre-build a Map<table, Map<column, Validator[]>> so per-row lookups
  // are O(1) regardless of how the user typed the config object. We
  // also normalise the "single validator" form into a single-element
  // array — the runtime loop is then uniform.
  const tables = new Map<string, Map<string, Validator[]>>()
  for (const [table, cols] of Object.entries(config)) {
    const m = new Map<string, Validator[]>()
    for (const [col, spec] of Object.entries(cols)) {
      m.set(col, Array.isArray(spec) ? spec : [spec])
    }
    if (m.size > 0) tables.set(table, m)
  }

  /**
   * Run the configured validators for a single (column, value) pair.
   * Bails out for non-`ParamNode` values — raw SQL, sub-selects,
   * column references, function calls — since we can't extract a JS
   * value to assert against without executing the expression.
   */
  function checkValue(
    table: string,
    column: string,
    value: ExpressionNode,
    validators: Validator[],
  ): void {
    if (value.type !== "param") return
    runValidators(table, column, value.value, validators)
  }

  function transformInsert(node: InsertNode): InsertNode {
    const cols = tables.get(node.table.name)
    if (!cols) return node
    if (node.columns.length === 0 || node.values.length === 0) return node

    // Pre-resolve the validator list per INSERT column position so the
    // per-row loop just does a single lookup.
    const specs: (Validator[] | undefined)[] = node.columns.map((c) => cols.get(c))
    if (specs.every((s) => s === undefined)) return node

    for (const row of node.values) {
      for (let i = 0; i < row.length; i++) {
        const spec = specs[i]
        if (!spec) continue
        const v = row[i]
        if (!v) continue
        checkValue(node.table.name, node.columns[i]!, v, spec)
      }
    }
    return node
  }

  function transformUpdate(node: UpdateNode): UpdateNode {
    const cols = tables.get(node.table.name)
    if (!cols) return node
    if (node.set.length === 0) return node

    for (const s of node.set) {
      const spec = cols.get(s.column)
      if (!spec) continue
      checkValue(node.table.name, s.column, s.value, spec)
    }
    return node
  }

  return {
    name: "validators",
    transformNode(node: ASTNode): ASTNode {
      switch (node.type) {
        case "insert":
          return transformInsert(node)
        case "update":
          return transformUpdate(node)
        default:
          return node
      }
    },
  }
}
