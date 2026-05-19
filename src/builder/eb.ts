import {
  col as rawCol,
  lit as rawLit,
  param as rawParam,
  and as rawAnd,
  or as rawOr,
  fn as rawFn,
  star as rawStar,
  exists as rawExists,
  cast as rawCast,
  not as rawNot,
} from "../ast/expression.ts"
import type {
  CaseNode,
  ExpressionNode,
  FrameBound,
  FrameExclude,
  FrameKind,
  FrameSpec,
  FullTextSearchMode,
  FullTextSearchNode,
  FunctionCallNode,
  JsonAccessNode,
  LiteralNode,
  OrderByNode,
  SelectNode,
  TupleNode,
  ValuesClauseNode,
  WindowFunctionNode,
} from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { brandExpression, isExpression } from "../ast/typed-expression.ts"
import { InvalidExpressionError } from "../errors.ts"
import type { SelectType } from "../schema/types.ts"
import { notifyUnsafeUsage } from "../security.ts"
import { validateFunctionName } from "../utils/security.ts"

/**
 * Assert that a variadic builder received at least `min` arguments. Use
 * at the entry point of functions whose SQL form rejects the empty case
 * on every dialect (COALESCE, CONCAT, GREATEST, LEAST, …). The resulting
 * error points at the caller instead of surfacing as a driver-level
 * parse failure at execution time.
 */
function assertMinArity(name: string, args: readonly unknown[], min: number): void {
  if (args.length < min) {
    const words = ["zero", "one", "two", "three"]
    const count = min < words.length ? words[min] : String(min)
    throw new InvalidExpressionError(
      `${name}() requires at least ${count} argument${min === 1 ? "" : "s"}, got ${args.length}`,
    )
  }
}

/**
 * A typed column reference that exposes comparison methods.
 *
 * ```ts
 * // users.id.eq(42) → ("id" = $1) with param [42]
 * // users.name.like("%ali%") → ("name" LIKE '%ali%')
 * ```
 */
/**
 * Accepted RHS for a Col comparison: raw value, another Col, or Expression.
 * This is what unifies the v0.1 `.eq(x)` overload surface — no more `.eqCol` / `.eqExpr`.
 */
export type CmpArg<T> = T | Col<T> | Expression<T>

function rhsNode<T>(value: CmpArg<T>): ExpressionNode {
  if (value instanceof Col) return (value as Col<T>)._node
  // Symbol-branded `isExpression` — a user object with a `.node` key
  // (e.g. a JSONB value) is not an Expression and is auto-parameterized.
  if (isExpression(value)) return (value as Expression<T>).node
  return autoParam(value)
}

/**
 * True when the RHS of a comparison is semantically `null` — either the
 * raw JS value or a wrapped `val(null)` / `Expression<null>` whose
 * underlying node is a literal `NULL`. Used by `Col.eq()` / `Col.neq()`
 * to auto-lower to `IS NULL` / `IS NOT NULL` (SQL's three-valued logic
 * makes `col = NULL` always UNKNOWN — it never matches).
 */
function isNullRhs<T>(value: CmpArg<T>): boolean {
  if (value === null) return true
  if (value instanceof Col) return false
  if (!isExpression(value)) return false
  const node = (value as Expression<T>).node
  return node.type === "literal" && (node as LiteralNode).value === null
}

export class Col<T> {
  /** @internal */
  readonly _node: ExpressionNode
  declare readonly _type: T

  constructor(column: string, table?: string) {
    this._node = rawCol(column, table)
  }

  /**
   * `=` — accepts raw value, another Col, or Expression.
   *
   * Passing `null` (either as a raw value or `val(null)`) auto-lowers to
   * `IS NULL` because `col = NULL` always evaluates to `UNKNOWN` in SQL
   * three-valued logic and never matches. This is a footgun every ORM
   * eventually works around; we do it at the builder level so the
   * emitted SQL matches user intent.
   */
  eq(value: CmpArg<T>): Expression<boolean> {
    if (isNullRhs(value)) {
      return wrap({ type: "is_null", expr: this._node, negated: false })
    }
    return wrap(binOp("=", this._node, rhsNode(value)))
  }

  /** `!=` — `null` / `val(null)` auto-lowers to `IS NOT NULL` (same reason as `.eq(null)`). */
  neq(value: CmpArg<T>): Expression<boolean> {
    if (isNullRhs(value)) {
      return wrap({ type: "is_null", expr: this._node, negated: true })
    }
    return wrap(binOp("!=", this._node, rhsNode(value)))
  }

  /**
   * `>` — greater than. Accepts raw value, another `Col`, or `Expression`.
   *
   * ```ts
   * .where(({ age }) => age.gt(18))
   * // WHERE "age" > $1
   * ```
   *
   * NULL handling: `col > NULL` evaluates to UNKNOWN per SQL three-
   * valued logic and never matches. Use `col.isNull({ negate: true })`
   * if you want "not null" — `.gt(null)` produces `WHERE col > NULL`
   * which is always false; that's the caller's intent or it isn't.
   */
  gt(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp(">", this._node, rhsNode(value)))
  }

  /**
   * `>=` — greater than or equal. See `.gt()` for NULL handling.
   *
   * ```ts
   * .where(({ price }) => price.gte(100))
   * // WHERE "price" >= $1
   * ```
   */
  gte(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp(">=", this._node, rhsNode(value)))
  }

  /**
   * `<` — less than. See `.gt()` for NULL handling.
   *
   * ```ts
   * .where(({ age }) => age.lt(65))
   * // WHERE "age" < $1
   * ```
   */
  lt(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp("<", this._node, rhsNode(value)))
  }

  /**
   * `<=` — less than or equal. See `.gt()` for NULL handling.
   *
   * ```ts
   * .where(({ age }) => age.lte(65))
   * // WHERE "age" <= $1
   * ```
   */
  lte(value: CmpArg<T>): Expression<boolean> {
    return wrap(binOp("<=", this._node, rhsNode(value)))
  }

  /**
   * LIKE / ILIKE / NOT LIKE / NOT ILIKE — one method, opts for variants.
   * Pattern is always parameterized.
   */
  like(
    this: Col<string>,
    pattern: string,
    opts?: { negate?: boolean; insensitive?: boolean },
  ): Expression<boolean> {
    const op =
      opts?.negate === true
        ? opts?.insensitive === true
          ? "NOT ILIKE"
          : "NOT LIKE"
        : opts?.insensitive === true
          ? "ILIKE"
          : "LIKE"
    return wrap(binOp(op, this._node, autoParam(pattern)))
  }

  /**
   * `IN (...values)` / `NOT IN` via `{ negate: true }`. Also accepts a
   * SELECT subquery.
   *
   * **Null semantics.** SQL `col IN (1, NULL, 2)` never matches when
   * `col` itself is NULL (three-valued logic). If the caller passes a
   * literal `null` in the array, we transparently split the predicate
   * into `(col IN (1, 2) OR col IS NULL)` so the intent — "match any
   * of these values, including rows where col is NULL" — actually
   * holds. `NOT IN` with a null becomes `col NOT IN (1, 2) AND col IS
   * NOT NULL`.
   */
  in(values: T[] | SelectNode, opts?: { negate?: boolean }): Expression<boolean> {
    const negated = opts?.negate === true
    if (Array.isArray(values)) {
      // Single linear pass: detect nulls and stage the non-null values
      // in one go. The previous `.some(...) + .filter(...) + .map(...)`
      // chain walked the array three times and allocated two
      // intermediate arrays even when no nulls were present. At 100-value
      // arity this dominated the IN-list build cost.
      const len = values.length
      let hasNull = false
      const paramNodes: ExpressionNode[] = []
      for (let i = 0; i < len; i++) {
        const v = values[i]
        if (v === null) {
          hasNull = true
          continue
        }
        // Inlined `autoParam(v)` — saves a function call per value.
        paramNodes.push({ type: "param", index: 0, value: v })
      }
      const inNode: ExpressionNode = {
        type: "in",
        expr: this._node,
        values: paramNodes,
        negated,
      }
      if (!hasNull) return wrap(inNode)
      const nullCheck: ExpressionNode = {
        type: "is_null",
        expr: this._node,
        negated,
      }
      // NOT IN with null → IN-empty-is-TRUE + AND IS NOT NULL
      // IN    with null → IN-values + OR IS NULL
      const combined: ExpressionNode = {
        type: "binary_op",
        op: negated ? "AND" : "OR",
        // IF nonNull empty, inNode renders as TRUE (negated) / FALSE — still valid.
        left: inNode,
        right: nullCheck,
      }
      return wrap(combined)
    }
    return wrap({ type: "in", expr: this._node, values, negated })
  }

  /**
   * `IS NULL` / `IS NOT NULL` (via `{ negate: true }`).
   *
   * ```ts
   * .where(({ deleted_at }) => deleted_at.isNull())             // IS NULL
   * .where(({ email }) => email.isNull({ negate: true }))       // IS NOT NULL
   * ```
   *
   * `.eq(null)` and `.neq(null)` auto-lower to these forms, so this
   * method is mainly useful when `null` is dynamic.
   */
  isNull(opts?: { negate?: boolean }): Expression<boolean> {
    return wrap({ type: "is_null", expr: this._node, negated: opts?.negate === true })
  }

  /**
   * `IS [NOT] JSON [VALUE|SCALAR|ARRAY|OBJECT]` — SQL:2016 JSON
   * validity predicate. Use to filter rows whose JSON-string column
   * contains a well-formed JSON value (and optionally constrain the
   * kind: scalar literal, array, or object).
   *
   * ```ts
   * .where(({ payload }) => payload.isJson())                          // any valid JSON
   * .where(({ payload }) => payload.isJson({ kind: "object" }))        // object only
   * .where(({ payload }) => payload.isJson({ negate: true }))          // IS NOT JSON
   * ```
   *
   * Supported on PG 16+, MySQL 8, MSSQL. The SQLite printer throws
   * `UnsupportedDialectFeatureError` — use `json_valid(expr)` on
   * SQLite if you need a runtime check.
   */
  isJson(opts?: {
    kind?: "value" | "scalar" | "array" | "object"
    negate?: boolean
  }): Expression<boolean> {
    return wrap({
      type: "is_json",
      expr: this._node,
      kind: opts?.kind,
      negated: opts?.negate === true,
    })
  }

  /**
   * `BETWEEN low AND high`. The bounds are inclusive on both ends.
   * Pass `{ negate: true }` for `NOT BETWEEN`; `{ symmetric: true }`
   * for PG's `BETWEEN SYMMETRIC` (swaps low/high if `low > high`).
   *
   * ```ts
   * .where(({ age }) => age.between(18, 65))                    // age BETWEEN $1 AND $2
   * .where(({ age }) => age.between(0, 17, { negate: true }))   // age NOT BETWEEN
   * .where(({ age }) => age.between(65, 18, { symmetric: true })) // PG: swaps bounds
   * ```
   *
   * NULL handling: any NULL operand makes the whole expression
   * UNKNOWN. Use `.isNull()` if you specifically want to match nulls.
   */
  between(
    low: CmpArg<T>,
    high: CmpArg<T>,
    opts?: { negate?: boolean; symmetric?: boolean },
  ): Expression<boolean> {
    return wrap({
      type: "between",
      expr: this._node,
      low: rhsNode(low),
      high: rhsNode(high),
      negated: opts?.negate === true,
      symmetric: opts?.symmetric === true,
    })
  }

  /**
   * `IS DISTINCT FROM` — null-safe inequality. Two NULLs are NOT
   * distinct from each other (unlike `<>`, which returns UNKNOWN).
   * Pass `{ negate: true }` for `IS NOT DISTINCT FROM` (null-safe
   * equality).
   *
   * ```ts
   * .where(({ status }) => status.distinctFrom("archived"))
   * // status IS DISTINCT FROM $1
   * // — matches rows where status ≠ 'archived' OR status IS NULL.
   * ```
   *
   * Supported by PG, SQLite, MariaDB. MySQL 8 supports the `<=>`
   * operator with similar semantics. MSSQL has no direct equivalent;
   * sumak's MSSQL printer emits a `(NOT (col = val) OR col IS NULL)`
   * decomposition.
   */
  distinctFrom(value: T | null, opts?: { negate?: boolean }): Expression<boolean> {
    const op = opts?.negate === true ? "IS NOT DISTINCT FROM" : "IS DISTINCT FROM"
    return wrap(binOp(op, this._node, autoParam(value)))
  }

  /**
   * Promote this `Col<T>` to a raw `Expression<T>`. Useful when an API
   * accepts only `Expression` (e.g. `tuple(...)`, `over(...)`) and not
   * the column-proxy form.
   *
   * ```ts
   * // tuple() needs Expression[], not Col[]:
   * tuple(id.toExpr(), name.toExpr())
   * ```
   */
  toExpr(): Expression<T> {
    return wrap<T>(this._node)
  }

  /**
   * `CAST(col AS <dataType>)` — inline type cast. The dataType
   * string is emitted verbatim, so dialect-specific types
   * (`JSONB`, `TIMESTAMPTZ`, `NUMERIC(10,2)`) work but cross-dialect
   * portability is the caller's responsibility.
   *
   * ```ts
   * .select({ priceText: col.price.cast<string>("TEXT") })
   * // SELECT CAST("price" AS TEXT) AS "priceText"
   * ```
   */
  cast<R>(dataType: string): Expression<R> {
    return wrap<R>(rawCast(this._node, dataType))
  }

  /**
   * ASC ordering with this column. Equivalent to `.orderBy("col",
   * "ASC")` but useful when you want to express ordering inline as
   * an expression (e.g. inside `over()` window orderBy).
   */
  asc(): { expr: Expression<T>; direction: "ASC" } {
    return { expr: wrap<T>(this._node), direction: "ASC" }
  }

  /** DESC ordering — for use with orderBy(col.desc()) */
  desc(): { expr: Expression<T>; direction: "DESC" } {
    return { expr: wrap<T>(this._node), direction: "DESC" }
  }
}

// ── Internal helpers ──

function autoParam(value: unknown): ExpressionNode {
  return rawParam(0, value)
}

function binOp(op: string, left: ExpressionNode, right: ExpressionNode): ExpressionNode {
  return { type: "binary_op", op, left, right }
}

function wrap<T>(node: ExpressionNode): Expression<T> {
  return brandExpression<T>(node)
}

/**
 * Create typed column proxies for a table's columns.
 *
 * Type: { id: Col<number>, name: Col<string>, ... }
 */
export type ColumnProxies<DB, TB extends keyof DB> = {
  [K in keyof DB[TB] & string]: Col<SelectType<DB[TB][K]>>
}

/**
 * Create column proxy objects for use in where/on callbacks.
 */
export function createColumnProxies<DB, TB extends keyof DB>(
  _table: TB & string,
): ColumnProxies<DB, TB> {
  return new Proxy({} as ColumnProxies<DB, TB>, {
    get(_target, prop: string) {
      return new Col(prop, undefined)
    },
  })
}

/**
 * Expression builder callback type.
 *
 * ```ts
 * .where(({ id, name }) => id.eq(42))
 * ```
 */
export type WhereCallback<DB, TB extends keyof DB> = (
  cols: ColumnProxies<DB, TB>,
) => Expression<boolean>

// ── Combinators for callback results ──

/**
 * AND expressions — variadic: `and(a, b)` or `and(a, b, c, ...)`.
 *
 * **Warning — empty input:** `and()` with zero arguments returns `TRUE`.
 * If you spread a dynamic array that ends up empty and pipe the result into
 * `.where()` on an UPDATE or DELETE, the statement will affect every row.
 * The normalizer folds `WHERE TRUE` out entirely, so there is no visible
 * predicate in the emitted SQL. Guard your dynamic filter list before the
 * spread if a "no filters" branch is not intentional:
 *
 * ```ts
 * // Safe: explicit branch
 * const filter = preds.length === 0 ? undefined : and(...preds)
 * const q = filter ? base.where(filter) : base
 * ```
 */
export function and(...exprs: Expression<boolean>[]): Expression<boolean> {
  const n = exprs.length
  if (n === 0) return wrap(rawLit(true))
  if (n === 1) return exprs[0]!
  // Build the left-leaning AND tree with a plain loop. The previous
  // `.reduce(... wrap(rawAnd(...)))` allocated a fresh branded
  // Expression wrapper at every intermediate step — none of which
  // were observable to the caller. At 5-clause arity this halves
  // the per-call allocations: 1 final wrap + (n-1) binary_op nodes,
  // vs (n-1) of each.
  let node: ExpressionNode = (exprs[0] as Expression<boolean>).node
  for (let i = 1; i < n; i++) {
    node = {
      type: "binary_op",
      op: "AND",
      left: node,
      right: (exprs[i] as Expression<boolean>).node,
    }
  }
  return wrap(node)
}

/**
 * OR expressions — variadic: `or(a, b)` or `or(a, b, c, ...)`.
 * Empty input returns `FALSE` (matches nothing), which is the safe default.
 */
export function or(...exprs: Expression<boolean>[]): Expression<boolean> {
  const n = exprs.length
  if (n === 0) return wrap(rawLit(false))
  if (n === 1) return exprs[0]!
  // Same allocation-skipping pattern as `and()`. See that function's
  // comment for the rationale.
  let node: ExpressionNode = (exprs[0] as Expression<boolean>).node
  for (let i = 1; i < n; i++) {
    node = {
      type: "binary_op",
      op: "OR",
      left: node,
      right: (exprs[i] as Expression<boolean>).node,
    }
  }
  return wrap(node)
}

/** Raw literal value as expression */
export function val<T extends string | number | boolean | null>(value: T): Expression<T> {
  return wrap<T>(rawLit(value))
}

/**
 * PostgreSQL `EXCLUDED.<col>` reference for use inside
 * `ON CONFLICT DO UPDATE` expressions. Produces the correct
 * `EXCLUDED."name"` form — not `"EXCLUDED.name"` (one quoted
 * identifier with a literal dot) which is what `col("EXCLUDED.name")`
 * would do.
 *
 * ```ts
 * db.insertInto("users").values({ email, name })
 *   .onConflict({ columns: ["email"], do: { update: [{
 *     column: "name", value: excluded("name"),
 *   }] }})
 * ```
 */
export function excluded<T = unknown>(column: string): Expression<T> {
  return wrap<T>({ type: "column_ref", table: "EXCLUDED", column })
}

/**
 * Unsafe raw SQL expression — escape hatch for arbitrary SQL in expressions.
 *
 * **WARNING:** Never pass user-controlled input as the SQL string.
 * This bypasses all security validation and can lead to SQL injection.
 *
 * ```ts
 * .where(() => unsafeRawExpr("age > 18"))
 * .select({ year: unsafeRawExpr<number>("EXTRACT(YEAR FROM created_at)") })
 * ```
 *
 * Dev-mode audit: set `process.env.SUMAK_WARN_UNSAFE` or call
 * `setUnsafeWarnHandler(fn)` to receive a one-time callback per call
 * site (deduplicated by stack trace). Useful for getting a signal on
 * how much unsafe SQL the codebase accumulates over time without
 * failing the build.
 */
export function unsafeRawExpr<T = unknown>(sql: string, params: unknown[] = []): Expression<T> {
  notifyUnsafeUsage("unsafeRawExpr", sql)
  return wrap<T>({ type: "raw", sql, params })
}

/**
 * SQL function call with name validation.
 * Function names must be alphanumeric identifiers (prevents injection).
 * For non-standard function names, use `unsafeSqlFn()` with caution.
 */
export function sqlFn(name: string, ...args: Expression<any>[]): Expression<any> {
  validateFunctionName(name)
  return wrap(
    rawFn(
      name,
      args.map((a) => (a as any).node),
    ),
  )
}

/**
 * Unsafe SQL function call — no name validation.
 *
 * **WARNING:** Never pass user-controlled input as the function name.
 * This bypasses security validation and can lead to SQL injection.
 *
 * Dev-mode audit: same opt-in hook as {@link unsafeRawExpr}.
 */
export function unsafeSqlFn(name: string, ...args: Expression<any>[]): Expression<any> {
  notifyUnsafeUsage("unsafeSqlFn", name)
  return wrap(
    rawFn(
      name,
      args.map((a) => (a as any).node),
    ),
  )
}

/**
 * `merge_action()` — PG 17+ niladic projection that returns the
 * branch which fired for the row: `'INSERT'`, `'UPDATE'`, or
 * `'DELETE'`. Only meaningful inside a `RETURNING` clause on a
 * `MERGE` statement.
 *
 * ```ts
 * db.mergeInto("users", { ... })
 *   .whenMatchedThenUpdate(...)
 *   .whenNotMatchedThenInsert(...)
 *   .returning({ id: col("id"), action: mergeAction() })
 * ```
 *
 * The printer emits the bare `MERGE_ACTION()` form; PG recognizes
 * this as the standard `merge_action()` function. MSSQL has an
 * equivalent token (`$action`) but it's wired into the `OUTPUT`
 * clause syntactically (a pseudo-column, not a callable function) —
 * use {@link mergeActionMssql} on MSSQL. Mixing the two across
 * dialects produces SQL the engine will reject; the two helpers are
 * intentionally separate so the dialect choice is explicit.
 */
export function mergeAction(): Expression<string> {
  return wrap(rawFn("MERGE_ACTION", []))
}

/**
 * `$action` — SQL Server's MERGE / OUTPUT pseudo-column. Returns the
 * branch that fired for the row: `'INSERT'`, `'UPDATE'`, or `'DELETE'`.
 * Only meaningful inside an `OUTPUT` clause on a MERGE statement.
 *
 * ```ts
 * db.mergeInto("users", { ... })
 *   .whenMatchedThenUpdate(...)
 *   .whenNotMatchedThenInsert(...)
 *   .returning({ id: col("id"), action: mergeActionMssql() })
 * ```
 *
 * The MSSQL printer emits the bare `$action` token (no parentheses —
 * SQL Server treats it as a pseudo-column, not a function call); on
 * any other dialect a `mergeActionMssql()` projection would compile
 * to invalid SQL the engine rejects. This is the MSSQL analogue of
 * {@link mergeAction} (which emits PG's `MERGE_ACTION()`). The two
 * helpers are kept separate rather than dialect-detected at print time
 * so the choice is explicit on the call site — the maintainers chose
 * that trade-off for the first cut.
 *
 * Internally we use a sentinel function-call node (name
 * `__SUMAK_MSSQL_ACTION__`) which the MSSQL printer recognizes and
 * rewrites to `$action`. The sentinel name is alphanumeric so it
 * passes `validateFunctionName`, and it's not in the standard /
 * niladic function tables, so other printers emit it verbatim — which
 * is exactly the "wrong but visible" behavior we want on non-MSSQL
 * dialects (the engine errors at parse, pointing at the offending
 * call site).
 */
export function mergeActionMssql(): Expression<string> {
  return wrap(rawFn(MSSQL_ACTION_FUNCTION_NAME, []))
}

/**
 * Sentinel function name emitted by {@link mergeActionMssql} so the
 * MSSQL printer can find-and-replace it with the `$action` pseudo-
 * column inside MERGE OUTPUT. Exported for the printer; not intended
 * for direct user use.
 */
export const MSSQL_ACTION_FUNCTION_NAME = "__SUMAK_MSSQL_ACTION__"

// Aggregate helpers live in `./aggregate.ts` so this file can stay
// focused on the typed-expression core. The re-export here preserves
// the historical `import { count } from "sumak"` shape so user code
// is unchanged. See the dedicated file for full JSDoc.
export {
  anyValue,
  arrayAgg,
  avg,
  avgDistinct,
  corr,
  count,
  countDistinct,
  covarPop,
  covarSamp,
  jsonAgg,
  max,
  min,
  percentileCont,
  percentileDisc,
  regrIntercept,
  regrR2,
  regrSlope,
  stddev,
  stddevPop,
  stddevSamp,
  stringAgg,
  sum,
  sumDistinct,
  variance,
  variancePop,
  varianceSamp,
  aggOrderBy,
  filter,
  withinGroup,
} from "./aggregate.ts"

/** COALESCE(a, b, c, ...) — returns first non-null value */
export function coalesce<T>(...args: Expression<T | null>[]): Expression<T> {
  // Every dialect rejects `COALESCE()`. Catch at build time so the error
  // points at the caller, not at the driver's eventual parse failure.
  assertMinArity("coalesce", args, 1)
  return wrap(
    rawFn(
      "COALESCE",
      args.map((a) => (a as any).node),
    ),
  )
}

/** NOT expr */
export function not(expr: Expression<boolean>): Expression<boolean> {
  return wrap(rawNot((expr as any).node))
}

/**
 * `a + b` — numeric addition. Use `concat()` for string
 * concatenation; the `+` operator on strings is dialect-specific
 * (MSSQL only) and sumak's typed builder won't let you mix them.
 *
 * **Integer division surprise** on PG / MySQL: `add(val(1), val(2))`
 * is fine, but `div(val(7), val(2))` returns 3, not 3.5 — integer
 * operands stay integer. Cast one operand to numeric/float to opt
 * into floating-point math.
 */
export function add(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("+", (a as any).node, (b as any).node))
}

/**
 * `a - b` — numeric subtraction. Same NULL semantics as `+`:
 * NULL operand makes the whole expression NULL.
 */
export function sub(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("-", (a as any).node, (b as any).node))
}

/**
 * `a * b` — numeric multiplication. Use `coalesce` to short-circuit
 * NULL operands if you want a sensible default.
 */
export function mul(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("*", (a as any).node, (b as any).node))
}

/**
 * `a / b` — numeric division. Two footguns:
 *
 * 1. **Integer division** — on PG / MySQL, integer ÷ integer stays
 *    integer (`7/2 = 3`). Cast one operand: `div(cast(col("hits"),
 *    "numeric"), col("total"))`.
 * 2. **Divide-by-zero** — every dialect throws on `x / 0`. The
 *    standard guard is `div(a, nullif(b, val(0)))`, which yields
 *    NULL instead of an error.
 */
export function div(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("/", (a as any).node, (b as any).node))
}

/**
 * `a % b` — modulo. PG / MySQL / SQLite use `%`; MSSQL also accepts
 * it. Divide-by-zero behaves the same as `div` — guard with `nullif`.
 */
export function mod(a: Expression<number>, b: Expression<number>): Expression<number> {
  return wrap(binOp("%", (a as any).node, (b as any).node))
}

/**
 * `-expr` — unary minus. NULL input → NULL output. Prefer
 * `mul(val(-1), expr)` only if you specifically want the `*` printed
 * (e.g. to keep operator precedence visible in raw SQL).
 */
export function neg(expr: Expression<number>): Expression<number> {
  return wrap({
    type: "unary_op",
    op: "-",
    operand: (expr as any).node,
    position: "prefix" as const,
  })
}

/** Wrap a SELECT query as a scalar subquery expression. */
export function subqueryExpr<T>(query: SelectNode): Expression<T> {
  return wrap<T>({ type: "subquery", query })
}

/** EXISTS (subquery) */
export function exists(query: SelectNode): Expression<boolean> {
  return wrap(rawExists(query))
}

/** NOT EXISTS (subquery) */
export function notExists(query: SelectNode): Expression<boolean> {
  return wrap(rawExists(query, true))
}

/** CAST(expr AS type) */
export function cast<T>(expr: Expression<any>, dataType: string): Expression<T> {
  return wrap<T>(rawCast((expr as any).node, dataType))
}

/**
 * `expr IS [NOT] JSON [VALUE|SCALAR|ARRAY|OBJECT]` — SQL:2016
 * predicate that asserts the value is well-formed JSON, optionally
 * constraining the kind. Useful for filtering ETL staging tables
 * where a `TEXT` column carries JSON encoded as a string.
 *
 * ```ts
 * isJson(col.payload)                                    // (payload IS JSON)
 * isJson(col.payload, { kind: "object" })                // (payload IS JSON OBJECT)
 * isJson(col.payload, { negate: true })                  // (payload IS NOT JSON)
 * isJson(col.payload, { kind: "array", negate: true })   // (payload IS NOT JSON ARRAY)
 * ```
 *
 * Dialect support: PG 16+, MySQL 8, MSSQL. The SQLite printer
 * refuses — there's no direct equivalent (json_valid has different
 * semantics).
 */
export function isJson(
  expr: Expression<any> | Col<any>,
  opts?: {
    kind?: "value" | "scalar" | "array" | "object"
    negate?: boolean
  },
): Expression<boolean> {
  const node = expr instanceof Col ? expr._node : (expr as Expression<any>).node
  return wrap({
    type: "is_json",
    expr: node,
    kind: opts?.kind,
    negated: opts?.negate === true,
  })
}

/**
 * `JSON_VALUE(json_expr, '$.path' [RETURNING type])` — SQL:2016
 * scalar JSON extraction. Differs from PG's `->>` operator in two
 * ways:
 *
 * 1. Returns a SQL-typed scalar (default `text` / `varchar`) rather
 *    than a JSON-typed value, so the result can be compared with
 *    `=` to a plain string / number without an extra cast.
 * 2. Accepts an optional `RETURNING <type>` clause that casts the
 *    extracted value to the requested SQL type in-place. PG 17+ and
 *    MySQL 8 support this; MSSQL does not (always returns
 *    nvarchar(4000) — wrap with `cast()` instead).
 *
 * ```ts
 * jsonValue(body, "$.name")
 *   // JSON_VALUE("body", '$.name')
 *
 * jsonValue(body, "$.age", { returning: "int" })
 *   // JSON_VALUE("body", '$.age' RETURNING int)
 * ```
 *
 * Dialect support: PG 17+, MySQL 8, MSSQL. SQLite has no direct
 * equivalent (`json_extract` differs on both path grammar and
 * missing-vs-null semantics) and the printer refuses.
 *
 * The empty / error handlers (`NULL ON ERROR`, `DEFAULT 'x' ON
 * ERROR`, etc.) are part of the SQL:2016 grammar but not surfaced
 * here yet — write the raw clause via `unsafeRawExpr` if needed.
 */
export function jsonValue<T = unknown>(
  jsonExpr: Expression<any> | Col<any>,
  path: string,
  opts?: { returning?: string },
): Expression<T> {
  const node = jsonExpr instanceof Col ? jsonExpr._node : (jsonExpr as Expression<any>).node
  const fnNode: FunctionCallNode = {
    type: "function_call",
    name: "JSON_VALUE",
    args: [node, rawLit(path)],
  }
  if (opts?.returning !== undefined) {
    fnNode.returningType = opts.returning
  }
  return wrap<T>(fnNode)
}

/**
 * `JSON_QUERY(json_expr, '$.path' [RETURNING type])` — SQL:2016
 * JSON-returning sibling of {@link jsonValue}. Where `JSON_VALUE`
 * coerces the extracted value to a SQL scalar (text by default),
 * `JSON_QUERY` returns a JSON-typed value — useful when the path
 * resolves to an object or array.
 *
 * ```ts
 * jsonQuery(body, "$.address")
 *   // JSON_QUERY("body", '$.address')
 *
 * jsonQuery(body, "$.tags", { returning: "jsonb" })
 *   // JSON_QUERY("body", '$.tags' RETURNING jsonb)  -- PG 17+
 * ```
 *
 * Dialect support: PG 17+ (bare + RETURNING) and MSSQL (bare only —
 * MSSQL's `JSON_QUERY` always returns nvarchar). MySQL 8 has no
 * `JSON_QUERY` (use `JSON_EXTRACT`); SQLite has nothing equivalent.
 * The printer refuses on MySQL / SQLite via the {@link JSON_QUERY_FN}
 * flag; MSSQL refuses the `returning` clause via the same
 * `returningType` guard used for `JSON_VALUE`.
 *
 * The empty / error handlers (`NULL ON EMPTY`, `EMPTY ARRAY ON
 * ERROR`, etc.) and `WRAPPER` / `KEEP QUOTES` clauses from the full
 * SQL:2016 grammar are not surfaced here — write the raw clause via
 * `unsafeRawExpr` if needed.
 */
export function jsonQuery<T = unknown>(
  jsonExpr: Expression<any> | Col<any>,
  path: string,
  opts?: { returning?: string },
): Expression<T> {
  const node = jsonExpr instanceof Col ? jsonExpr._node : (jsonExpr as Expression<any>).node
  const fnNode: FunctionCallNode = {
    type: "function_call",
    name: "JSON_QUERY",
    args: [node, rawLit(path)],
  }
  if (opts?.returning !== undefined) {
    fnNode.returningType = opts.returning
  }
  return wrap<T>(fnNode)
}

/**
 * `JSON_EXISTS(json_expr, '$.path')` — SQL:2016 boolean predicate
 * that returns TRUE when the path resolves to a value in the JSON
 * document. Closer to `column ? 'key'` on PG (existence test) than
 * to `JSON_VALUE`/`JSON_QUERY` (extraction).
 *
 * ```ts
 * .where(() => jsonExists(body, "$.email"))
 *   // WHERE JSON_EXISTS("body", '$.email')
 * ```
 *
 * Dialect support: PG 17+ and MSSQL accept the standard form. MySQL
 * 8 has `JSON_CONTAINS_PATH(json, 'one'|'all', '$.path', …)` with a
 * different argument shape, so this builder refuses on MySQL
 * (callers wanting that semantics should write it via `sqlFn`).
 * SQLite has no equivalent at all.
 *
 * No `RETURNING` clause — the result is always boolean.
 */
export function jsonExists(
  jsonExpr: Expression<any> | Col<any>,
  path: string,
): Expression<boolean> {
  const node = jsonExpr instanceof Col ? jsonExpr._node : (jsonExpr as Expression<any>).node
  return wrap<boolean>({
    type: "function_call",
    name: "JSON_EXISTS",
    args: [node, rawLit(path)],
  })
}

/**
 * JSON access operator: expr->path, expr->>path, etc.
 *
 * ```ts
 * jsonRef(cols.data, "name", "->>")  // data->>'name'
 * ```
 */
export function jsonRef<T = unknown>(
  expr: Expression<any>,
  path: string,
  operator: "->" | "->>" | "#>" | "#>>" = "->",
): Expression<T> {
  const node: JsonAccessNode = {
    type: "json_access",
    expr: (expr as any).node,
    path,
    operator,
  }
  return wrap<T>(node)
}

/**
 * Full-text search expression.
 *
 * Dialect-aware: PG uses tsvector/tsquery, MySQL uses MATCH/AGAINST,
 * SQLite uses FTS5 MATCH, MSSQL uses CONTAINS/FREETEXT.
 *
 * ```ts
 * // PostgreSQL: to_tsvector("name") @@ to_tsquery($1)
 * .where(() => textSearch([cols.name], val("alice")))
 *
 * // MySQL: MATCH(`name`) AGAINST(? IN BOOLEAN MODE)
 * .where(() => textSearch([cols.name], val("alice"), { mode: "boolean" }))
 * ```
 */
export function textSearch(
  columns: Expression<any>[],
  query: Expression<any>,
  options?: { mode?: FullTextSearchMode; language?: string },
): Expression<boolean> {
  const node: FullTextSearchNode = {
    type: "full_text_search",
    columns: columns.map((c) => (c as any).node),
    query: (query as any).node,
    mode: options?.mode,
    language: options?.language,
  }
  return wrap<boolean>(node)
}

/**
 * CASE expression builder.
 *
 * ```ts
 * case_()
 *   .when(cols.status.eq("active"), val(1))
 *   .when(cols.status.eq("inactive"), val(0))
 *   .else_(val(-1))
 *   .end()
 * ```
 */
export function case_(operand?: Expression<any>): CaseBuilder<never> {
  return new CaseBuilder(operand ? (operand as any).node : undefined, [])
}

export class CaseBuilder<T> {
  /** @internal */
  private _operand: ExpressionNode | undefined
  /** @internal */
  private _whens: { condition: ExpressionNode; result: ExpressionNode }[]
  /** @internal */
  private _else: ExpressionNode | undefined

  /** @internal */
  constructor(
    operand: ExpressionNode | undefined,
    whens: { condition: ExpressionNode; result: ExpressionNode }[],
    else_?: ExpressionNode,
  ) {
    this._operand = operand
    this._whens = whens
    this._else = else_
  }

  when<R>(condition: Expression<boolean>, result: Expression<R>): CaseBuilder<T | R> {
    return new CaseBuilder<T | R>(this._operand, [
      ...this._whens,
      { condition: (condition as any).node, result: (result as any).node },
    ])
  }

  else_<R>(result: Expression<R>): CaseBuilder<T | R> {
    return new CaseBuilder<T | R>(this._operand, this._whens, (result as any).node)
  }

  end(): Expression<T> {
    if (this._whens.length === 0) {
      // Every SQL dialect requires at least one WHEN in a CASE
      // expression — `CASE END` and `CASE ELSE … END` are both syntax
      // errors. Surface the bug at the builder call rather than at
      // `toSQL()` time where the stack trace points at the printer.
      throw new InvalidExpressionError(
        "case_().end() — CASE requires at least one .when(cond, result) before .end().",
      )
    }
    const node: CaseNode = {
      type: "case",
      operand: this._operand,
      whens: this._whens,
      else_: this._else,
    }
    return wrap<T>(node)
  }
}

// ── Window Function Builder ──

/**
 * Wrap an aggregate or window function in an `OVER (...)` clause, or
 * reference a named window declared via `.window(name, build)` on the
 * surrounding SELECT.
 *
 * Two shapes — discriminated by the second arg type:
 *
 * ```ts
 * // Inline window spec — callback configures partitionBy / orderBy / frame
 * over(rowNumber(), w => w.partitionBy("dept").orderBy("salary", "DESC"))
 * // -> ROW_NUMBER() OVER (PARTITION BY "dept" ORDER BY "salary" DESC)
 *
 * // Running total with frame
 * over(sum(col("amount")), w => w.orderBy("id").rows(
 *   { type: "unbounded_preceding" },
 *   { type: "current_row" },
 * ))
 *
 * // Named-window reference — register on the SELECT, then reference
 * db.selectFrom("t")
 *   .window("w", b => b.partitionBy("dept").orderBy("salary"))
 *   .select({
 *     rn: over(rowNumber(), "w"),
 *     run: over(sum(col("amount")), "w"),
 *   })
 * // -> SELECT ROW_NUMBER() OVER "w", SUM("amount") OVER "w" FROM "t"
 * //    WINDOW "w" AS (PARTITION BY "dept" ORDER BY "salary")
 * ```
 *
 * Bare ranking functions (`rowNumber()`, `rank()`, `denseRank()`)
 * **must** be wrapped in `over(...)` — they throw at print time
 * otherwise. SQL allows `COUNT(*)` without `OVER`, but
 * `ROW_NUMBER()` does not. MSSQL does not support the SQL:2003 named
 * `WINDOW` clause; its printer throws when it sees the named form or a
 * non-empty `windows` slot on the SELECT.
 */
export function over<T>(
  fn: Expression<T>,
  build: ((w: WindowBuilder) => WindowBuilder) | string,
): Expression<T> {
  const fnNode = (fn as any).node as FunctionCallNode
  if (typeof build === "string") {
    // Named-window reference — leave the inline spec slots empty;
    // the printer reads `windowName` and emits `OVER name` instead
    // of `OVER (...)`. The actual partitionBy/orderBy/frame lives on
    // the surrounding SelectNode.windows entry.
    const node: WindowFunctionNode = {
      type: "window_function",
      fn: fnNode,
      partitionBy: [],
      orderBy: [],
      windowName: build,
    }
    return wrap<T>(node)
  }
  const builder = build(new WindowBuilder())
  const node: WindowFunctionNode = {
    type: "window_function",
    fn: fnNode,
    ...builder._build(),
  }
  return wrap<T>(node)
}

export class WindowBuilder {
  #partitionBy: ExpressionNode[] = []
  #orderBy: OrderByNode[] = []
  #frame: FrameSpec | undefined

  /**
   * `PARTITION BY col1, col2, …` — split the row stream into groups
   * before applying the window function. Each call replaces the
   * partition list (calls don't accumulate); pass all columns at once.
   *
   * ```ts
   * over(rank(), w => w.partitionBy("dept", "team").orderBy("salary", "DESC"))
   * ```
   */
  partitionBy(...columns: string[]): WindowBuilder {
    const b = new WindowBuilder()
    b.#partitionBy = columns.map((c) => rawCol(c))
    b.#orderBy = this.#orderBy
    b.#frame = this.#frame
    return b
  }

  /**
   * `ORDER BY col [ASC|DESC]` — append one ordering key per call.
   * Multiple `.orderBy()` calls accumulate, so `.orderBy("a").orderBy("b")`
   * emits `ORDER BY "a" ASC, "b" ASC`.
   *
   * For ranking functions (`rowNumber`, `rank`, `denseRank`) this
   * defines tie-breaking and is effectively required — without it the
   * row numbering is non-deterministic.
   */
  orderBy(column: string, direction: "ASC" | "DESC" = "ASC"): WindowBuilder {
    const b = new WindowBuilder()
    b.#partitionBy = this.#partitionBy
    b.#orderBy = [...this.#orderBy, { expr: rawCol(column), direction }]
    b.#frame = this.#frame
    return b
  }

  /**
   * `ROWS BETWEEN start AND end` — physical-row frame. Most common
   * choice for cumulative aggregates because it counts rows, not
   * peers. Omit `end` and SQL defaults to `CURRENT ROW`.
   *
   * ```ts
   * // Running total since the first row
   * over(sum(col("amount")), w => w.orderBy("id").rows(
   *   { type: "unbounded_preceding" },
   * ))
   * ```
   */
  rows(start: FrameBound, end?: FrameBound): WindowBuilder {
    return this.#withFrame("ROWS", start, end)
  }

  /**
   * `RANGE BETWEEN start AND end` — logical (value-based) frame. Peers
   * (rows with equal `ORDER BY` keys) are treated as a single frame
   * step, which makes `RANGE` semantics different from `ROWS` whenever
   * ties exist in the ordering.
   */
  range(start: FrameBound, end?: FrameBound): WindowBuilder {
    return this.#withFrame("RANGE", start, end)
  }

  /**
   * `GROUPS BETWEEN start AND end` — SQL:2011 frame that counts
   * **peer groups** rather than rows or values. Supported on PG and
   * SQLite; MSSQL / MySQL reject at compile time.
   */
  groups(start: FrameBound, end?: FrameBound): WindowBuilder {
    return this.#withFrame("GROUPS", start, end)
  }

  #withFrame(kind: FrameKind, start: FrameBound, end?: FrameBound): WindowBuilder {
    const b = new WindowBuilder()
    b.#partitionBy = this.#partitionBy
    b.#orderBy = this.#orderBy
    // Preserve any previously-set EXCLUDE so the call order
    // `.exclude("group").rows(...)` doesn't silently drop the modifier.
    // The SQL grammar puts EXCLUDE *after* the frame bounds, but the
    // builder API doesn't enforce a single legal call order.
    b.#frame = { kind, start, end, exclude: this.#frame?.exclude }
    return b
  }

  /**
   * `EXCLUDE { CURRENT ROW | GROUP | TIES | NO OTHERS }` — SQL:2011
   * frame-exclude clause that trims rows out of an already-computed
   * frame. Must be called *after* one of `.rows()` / `.range()` /
   * `.groups()`; without a frame, EXCLUDE has nothing to attach to and
   * we throw an explicit error rather than silently emitting the
   * modifier on a default frame.
   *
   * - `"current_row"` — drop the current row from the frame.
   * - `"group"` — drop the current row and its peers (rows with the
   *   same `ORDER BY` keys).
   * - `"ties"` — drop peers but keep the current row.
   * - `"no_others"` — the implicit default; emitted explicitly only if
   *   the user asks for it (harmless on PG/SQLite).
   *
   * Supported on PG and SQLite. MySQL 8 and MSSQL throw at print time
   * via the `FRAME_EXCLUDE` feature flag.
   *
   * ```ts
   * // Running total of *other* rows in the partition
   * over(sum(col("amount")), w =>
   *   w.orderBy("id")
   *    .rows({ type: "unbounded_preceding" }, { type: "unbounded_following" })
   *    .exclude("current_row"),
   * )
   * ```
   */
  exclude(option: FrameExclude): WindowBuilder {
    if (this.#frame === undefined) {
      throw new InvalidExpressionError(
        "WindowBuilder.exclude() requires a frame — call .rows(), .range(), or .groups() first.",
      )
    }
    const b = new WindowBuilder()
    b.#partitionBy = this.#partitionBy
    b.#orderBy = this.#orderBy
    b.#frame = { ...this.#frame, exclude: option }
    return b
  }

  /** @internal — consumed by `over()` to project the builder's state. */
  _build(): { partitionBy: ExpressionNode[]; orderBy: OrderByNode[]; frame?: FrameSpec } {
    return { partitionBy: this.#partitionBy, orderBy: this.#orderBy, frame: this.#frame }
  }
}

// ── Convenience window functions ──

/**
 * `ROW_NUMBER()` — assigns each row a unique sequential integer
 * within its partition, starting at 1. Ties in `ORDER BY` are broken
 * arbitrarily but stably within a single call.
 *
 * Must be wrapped in `over(...)`; the print pass rejects a bare call.
 *
 * ```ts
 * .select({ rn: over(rowNumber(), w => w.partitionBy("dept").orderBy("hireDate")) })
 * ```
 */
export function rowNumber(): Expression<number> {
  return wrap(rawFn("ROW_NUMBER", []))
}

/**
 * `RANK()` — like `rowNumber`, but ties in `ORDER BY` get the same
 * rank and the next rank **skips** (1, 2, 2, 4). Use `denseRank` if
 * you want no gaps. Must be wrapped in `over(...)`.
 */
export function rank(): Expression<number> {
  return wrap(rawFn("RANK", []))
}

/**
 * `DENSE_RANK()` — like `rank`, but ties don't create gaps in the
 * sequence (1, 2, 2, 3 instead of 1, 2, 2, 4). Must be wrapped in
 * `over(...)`.
 */
export function denseRank(): Expression<number> {
  return wrap(rawFn("DENSE_RANK", []))
}

/**
 * `LAG(expr, offset?, default?)` — value of `expr` in a previous row
 * within the same window. `offset` defaults to 1, `default` to NULL.
 *
 * ```ts
 * // Previous month's revenue per region
 * over(lag(col("revenue")), w => w.partitionBy("region").orderBy("month"))
 * ```
 *
 * Needs `ORDER BY` on the window or the "previous row" is undefined.
 */
export function lag<T>(
  expr: Expression<T>,
  offset?: number,
  defaultValue?: Expression<T>,
): Expression<T> {
  const args: ExpressionNode[] = [(expr as any).node]
  if (offset !== undefined) args.push(rawLit(offset))
  if (defaultValue !== undefined) args.push((defaultValue as any).node)
  return wrap(rawFn("LAG", args))
}

/**
 * `LEAD(expr, offset?, default?)` — value of `expr` in a following
 * row within the same window. Mirror of `lag`. `offset` defaults to
 * 1, `default` to NULL. Requires `ORDER BY` on the window.
 */
export function lead<T>(
  expr: Expression<T>,
  offset?: number,
  defaultValue?: Expression<T>,
): Expression<T> {
  const args: ExpressionNode[] = [(expr as any).node]
  if (offset !== undefined) args.push(rawLit(offset))
  if (defaultValue !== undefined) args.push((defaultValue as any).node)
  return wrap(rawFn("LEAD", args))
}

/**
 * `NTILE(n)` — split the ordered partition into `n` roughly-equal
 * buckets and emit each row's bucket number (1..n). Useful for
 * quartiles / deciles.
 *
 * ```ts
 * .select({ quartile: over(ntile(4), w => w.orderBy("salary", "DESC")) })
 * ```
 */
export function ntile(n: number): Expression<number> {
  return wrap(rawFn("NTILE", [rawLit(n)]))
}

// ── Common SQL functions ──

/**
 * `UPPER(expr)` — uppercase the string. Standard SQL; supported on
 * all four dialects. NULL input produces NULL output.
 */
export function upper(expr: Expression<string>): Expression<string> {
  return wrap(rawFn("UPPER", [(expr as any).node]))
}

/**
 * `LOWER(expr)` — lowercase the string. Standard SQL; supported on
 * all four dialects. NULL input produces NULL output.
 */
export function lower(expr: Expression<string>): Expression<string> {
  return wrap(rawFn("LOWER", [(expr as any).node]))
}

/**
 * `CONCAT(a, b, …)` — variadic string concatenation. Minimum arity
 * is 1 (single-arg `CONCAT` is a no-op but legal).
 *
 * **NULL handling differs across dialects** — sumak emits the same
 * `CONCAT(...)` call everywhere and lets the database decide:
 * - **PostgreSQL** silently skips NULL arguments: `CONCAT('a', NULL, 'b')` → `'ab'`.
 * - **MySQL** returns NULL if any argument is NULL: same input → `NULL`.
 * - **SQLite** doesn't ship `CONCAT` at all on older builds (added in 3.44, 2023). Use `||` if portability matters.
 *
 * Wrap NULL-prone arguments in `coalesce(x, val(""))` if you need
 * portable behavior.
 */
export function concat(...args: Expression<string>[]): Expression<string> {
  assertMinArity("concat", args, 1)
  return wrap(
    rawFn(
      "CONCAT",
      args.map((a) => (a as any).node),
    ),
  )
}

/**
 * `SUBSTRING(expr FROM start [FOR length])` — substring extraction.
 * Indexes are **1-based** in SQL, not 0-based like JavaScript;
 * `substring(s, 1, 3)` returns the first 3 characters.
 *
 * `start` and `length` are emitted as integer literals rather than
 * parameters — they're usually constants and inlining keeps the
 * statement-cache key stable when only data varies.
 */
export function substring(
  expr: Expression<string>,
  start: number,
  length?: number,
): Expression<string> {
  const args: ExpressionNode[] = [(expr as any).node, rawLit(start)]
  if (length !== undefined) args.push(rawLit(length))
  return wrap(rawFn("SUBSTRING", args))
}

/**
 * `TRIM(expr)` — strip leading and trailing whitespace. For
 * single-side trim use the SQL standard `LTRIM` / `RTRIM` via
 * `sqlFn("LTRIM", expr)` / `sqlFn("RTRIM", expr)` (both in sumak's
 * known-function allowlist).
 */
export function trim(expr: Expression<string>): Expression<string> {
  return wrap(rawFn("TRIM", [(expr as any).node]))
}

/**
 * `LENGTH(expr)` — number of characters in the string. PG/MySQL/
 * SQLite return character length; on MSSQL `LENGTH` isn't standard,
 * use `sqlFn("LEN", expr)` instead. For byte length see
 * `sqlFn("OCTET_LENGTH", expr)` or dialect-specific variants.
 */
export function length(expr: Expression<string>): Expression<number> {
  return wrap(rawFn("LENGTH", [(expr as any).node]))
}

/**
 * `REGEXP_REPLACE(haystack, pattern, replacement[, flags])` — search
 * `haystack` for matches of `pattern` and substitute `replacement`.
 *
 * ```ts
 * regexpReplace(typedCol<string>("phone"), "[^0-9]", "")
 *   // PG/MySQL: REGEXP_REPLACE("phone", '[^0-9]', '')
 *
 * regexpReplace(typedCol<string>("body"), "(?i)foo", "BAR", "gi")
 *   // PG/MySQL: REGEXP_REPLACE("body", '(?i)foo', 'BAR', 'gi')
 * ```
 *
 * Dialect support (via {@link REGEXP_REPLACE_FN}):
 * - **PG** (since 7.4) — `regexp_replace(source, pattern, replacement[, flags])`
 * - **MySQL 8** — `REGEXP_REPLACE(expr, pat, repl[, pos[, occurrence[, match_type]]])`. This builder only emits the 4-arg form (no pos / occurrence); reach for `sqlFn("REGEXP_REPLACE", …)` if you need them.
 * - **SQLite** — requires the `regexp` extension (e.g. sqlite3 build with `SQLITE_ENABLE_REGEXP`). Flags are not supported on SQLite; passing a `flags` argument compiles fine but the engine errors at execution.
 * - **MSSQL** — no native equivalent; the printer refuses.
 *
 * `pattern`, `replacement`, and `flags` are emitted as inline SQL
 * string literals (via `rawLit`) rather than parameters. They're
 * typically constants, and inlining keeps the statement-cache key
 * stable when only the haystack varies row-to-row. Use
 * `unsafeRawExpr` if you need a fully parameterised pattern.
 */
export function regexpReplace(
  haystack: Expression<string>,
  pattern: string,
  replacement: string,
  flags?: string,
): Expression<string> {
  const args: ExpressionNode[] = [(haystack as any).node, rawLit(pattern), rawLit(replacement)]
  if (flags !== undefined) args.push(rawLit(flags))
  return wrap(rawFn("REGEXP_REPLACE", args))
}

/**
 * `REGEXP_LIKE(haystack, pattern[, flags])` — boolean test for
 * regex match. Returns TRUE iff `pattern` matches somewhere in
 * `haystack`.
 *
 * ```ts
 * .where(() => regexpLike(typedCol<string>("email"), "^[^@]+@[^@]+$"))
 *   // PG/MySQL: REGEXP_LIKE("email", '^[^@]+@[^@]+$')
 * ```
 *
 * Dialect support (via {@link REGEXP_LIKE_FN}):
 * - **PG 15+** has the standard `regexp_like(text, pattern[, flags])` function. Older PG users can write `expr ~ pattern` (or `~*` for case-insensitive) via `unsafeRawExpr`.
 * - **MySQL 8** — `REGEXP_LIKE(expr, pat[, match_type])`.
 * - **SQLite** — *no* `REGEXP_LIKE` function. The `REGEXP` operator (when the extension is loaded) gives the same semantics; reach for `sqlFn("REGEXP", expr, val(pattern))` or `unsafeRawExpr`.
 * - **MSSQL** — no native equivalent.
 *
 * `pattern` and `flags` are emitted inline (see {@link regexpReplace}
 * for the rationale).
 */
export function regexpLike(
  haystack: Expression<string>,
  pattern: string,
  flags?: string,
): Expression<boolean> {
  const args: ExpressionNode[] = [(haystack as any).node, rawLit(pattern)]
  if (flags !== undefined) args.push(rawLit(flags))
  return wrap<boolean>(rawFn("REGEXP_LIKE", args))
}

/**
 * PG `regexp_matches(haystack, pattern[, flags])` — returns the set
 * of captured substrings as a `text[]` array. With the `g` flag, the
 * function is set-returning and yields one row per match; without
 * `g`, it returns at most one row per input row.
 *
 * ```ts
 * regexpMatches(typedCol<string>("body"), "https?://([^\\s]+)", "g")
 *   // REGEXP_MATCHES("body", 'https?://([^\s]+)', 'g')
 * ```
 *
 * **PG-only.** MySQL / SQLite / MSSQL have no equivalent function
 * that returns the captured groups as an array — the printer refuses
 * via {@link REGEXP_MATCHES_FN}. For MySQL, `REGEXP_SUBSTR` returns
 * just the matched substring (no capture-group breakdown).
 */
export function regexpMatches(
  haystack: Expression<string>,
  pattern: string,
  flags?: string,
): Expression<string[]> {
  const args: ExpressionNode[] = [(haystack as any).node, rawLit(pattern)]
  if (flags !== undefined) args.push(rawLit(flags))
  return wrap<string[]>(rawFn("REGEXP_MATCHES", args))
}

/**
 * `REGEXP_SUBSTR(haystack, pattern[, position[, occurrence[, flags]]])`
 * — return the substring that matches `pattern`, or NULL if no
 * match. `position` is 1-based (SQL convention) and defaults to 1;
 * `occurrence` selects the Nth match and defaults to 1.
 *
 * ```ts
 * regexpSubstr(typedCol<string>("body"), "https?://[^\\s]+")
 *   // PG/MySQL: REGEXP_SUBSTR("body", 'https?://[^\s]+')
 *
 * regexpSubstr(typedCol<string>("body"), "\\d+", 1, 2, "i")
 *   // PG/MySQL: REGEXP_SUBSTR("body", '\d+', 1, 2, 'i')
 * ```
 *
 * Dialect support (via {@link REGEXP_SUBSTR_FN}):
 * - **PG 15+** — `regexp_substr(string, pattern[, start[, N[, flags]]])`.
 * - **MySQL 8** — `REGEXP_SUBSTR(expr, pat[, pos[, occurrence[, match_type]]])`.
 * - **SQLite** — no equivalent.
 * - **MSSQL** — no equivalent.
 *
 * `pattern` and `flags` are emitted inline; `position` and
 * `occurrence` are inlined as integer literals (callers usually
 * pass constants, and inlining keeps the plan-cache key stable).
 */
export function regexpSubstr(
  haystack: Expression<string>,
  pattern: string,
  position?: number,
  occurrence?: number,
  flags?: string,
): Expression<string> {
  const args: ExpressionNode[] = [(haystack as any).node, rawLit(pattern)]
  if (position !== undefined) {
    args.push(rawLit(position))
    if (occurrence !== undefined) {
      args.push(rawLit(occurrence))
      if (flags !== undefined) {
        args.push(rawLit(flags))
      }
    } else if (flags !== undefined) {
      throw new InvalidExpressionError(
        "regexpSubstr(): flags requires occurrence to be set (pass an explicit occurrence index, e.g. 1).",
      )
    }
  } else if (occurrence !== undefined || flags !== undefined) {
    throw new InvalidExpressionError(
      "regexpSubstr(): position must be set when passing occurrence or flags.",
    )
  }
  return wrap(rawFn("REGEXP_SUBSTR", args))
}

/**
 * `NOW()` — current transaction timestamp. PG / MySQL idiom; on
 * MSSQL and SQLite use `currentTimestamp()` instead, which compiles
 * to the SQL-standard `CURRENT_TIMESTAMP` keyword.
 *
 * Within a single transaction, `NOW()` returns the same value for
 * every call — it's the *transaction* start time on PG.
 */
export function now(): Expression<Date> {
  return wrap(rawFn("NOW", []))
}

/**
 * `CURRENT_TIMESTAMP` — SQL-standard timestamp keyword. Supported
 * on all four dialects (unlike `NOW()`, which is PG/MySQL-flavor).
 * Reach for this in cross-dialect code.
 */
export function currentTimestamp(): Expression<Date> {
  return wrap(rawFn("CURRENT_TIMESTAMP", []))
}

/**
 * EXTRACT field allowlist. Keep this in sync with what the underlying
 * dialects parse — the printer emits the field verbatim, so any string
 * not on this list would either fail at parse time or, worse, be
 * interpreted as something we didn't anticipate. Validating here points
 * the error at the builder call site rather than the driver.
 *
 * Includes the SQL standard common fields plus PG's extras (DOW, DOY,
 * EPOCH, ISOYEAR, ISODOW, MILLISECONDS, MICROSECONDS, CENTURY, DECADE,
 * MILLENNIUM, TIMEZONE, TIMEZONE_HOUR, TIMEZONE_MINUTE). On non-PG
 * dialects the engine may reject a PG-only field at parse — that's the
 * caller's signal that they reached for something portable they
 * shouldn't have.
 */
const EXTRACT_FIELDS: ReadonlySet<string> = new Set([
  "YEAR",
  "MONTH",
  "DAY",
  "HOUR",
  "MINUTE",
  "SECOND",
  "DOW",
  "DOY",
  "WEEK",
  "QUARTER",
  "EPOCH",
  "ISOYEAR",
  "ISODOW",
  "MILLISECOND",
  "MILLISECONDS",
  "MICROSECOND",
  "MICROSECONDS",
  "CENTURY",
  "DECADE",
  "MILLENNIUM",
  "TIMEZONE",
  "TIMEZONE_HOUR",
  "TIMEZONE_MINUTE",
])

/**
 * `EXTRACT(<field> FROM <expr>)` — pull a calendar / clock component
 * out of a timestamp / date / time value. SQL standard; supported on
 * all four dialects (the recognised field set differs — `EPOCH`,
 * `ISOYEAR`, `DOW`, `DOY` are PG-only; the engines parse the standard
 * fields YEAR / MONTH / DAY / HOUR / MINUTE / SECOND).
 *
 * ```ts
 * extract("year", typedCol<Date>("created_at"))
 *   // EXTRACT(YEAR FROM "created_at")
 *
 * extract("epoch", typedCol<Date>("ts"))
 *   // PG: EXTRACT(EPOCH FROM "ts") — seconds since 1970-01-01
 * ```
 *
 * The `field` is validated against a fixed allowlist (case-insensitive)
 * — passing an unknown keyword throws at build time with a hint. Use
 * `unsafeRawExpr` if you genuinely need an EXTRACT field that we
 * haven't catalogued (PG accepts a handful of extras like `JULIAN`).
 */
export function extract(field: string, expr: Expression<any> | Col<any>): Expression<number> {
  const upper = field.toUpperCase()
  if (!EXTRACT_FIELDS.has(upper)) {
    throw new InvalidExpressionError(
      `extract(): unknown field "${field}". Allowed: ${Array.from(EXTRACT_FIELDS).join(", ")}. ` +
        "Reach for unsafeRawExpr() if your dialect supports a field that isn't catalogued.",
    )
  }
  const exprNode = expr instanceof Col ? expr._node : (expr as Expression<any>).node
  const fnNode: FunctionCallNode = {
    type: "function_call",
    name: "EXTRACT",
    args: [exprNode],
    extractField: upper,
  }
  return wrap<number>(fnNode)
}

/**
 * PG `DATE_TRUNC(<unit>, <expr>)` — round a timestamp down to the
 * named unit (`'year'`, `'month'`, `'day'`, `'hour'`, `'minute'`, …).
 * The unit is a string literal that PG inspects at planning time; the
 * builder validates against an alphanumeric allowlist before emitting
 * to keep injection out of the picture.
 *
 * ```ts
 * dateTrunc("month", typedCol<Date>("created_at"))
 *   // DATE_TRUNC('month', "created_at")
 * ```
 *
 * **PG-only.** MSSQL has a `DATETRUNC` function with a different shape
 * (identifier field, not a quoted string); MySQL has no exact
 * equivalent — `DATE_FORMAT(ts, '%Y-%m-01')` is the usual workaround;
 * SQLite uses `strftime`. The other dialects' printers throw via
 * `DATE_TRUNC_FN`.
 */
export function dateTrunc(unit: string, expr: Expression<any> | Col<any>): Expression<Date> {
  // Validate the unit looks like a SQL identifier — PG accepts a fixed
  // list (microseconds … millennium) and rejects anything else at
  // execution time, but we keep the rule loose here so PG-version-
  // specific extras still go through. The injection-relevant check is
  // that there's no `'` or `\\` that would break out of the literal.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(unit)) {
    throw new InvalidExpressionError(
      `dateTrunc(): unit must be a SQL identifier (letters/digits/underscores), got "${unit}".`,
    )
  }
  const exprNode = expr instanceof Col ? expr._node : (expr as Expression<any>).node
  return wrap<Date>(rawFn("DATE_TRUNC", [rawLit(unit.toLowerCase()), exprNode]))
}

/**
 * PG `AGE(end?, start)` — returns a symbolic `interval` difference
 * between two timestamps (years + months + days + …). The two-arg form
 * is `AGE(end, start)`; the one-arg form `AGE(start)` is shorthand for
 * `AGE(current_date, start)` — *not* `AGE(now(), start)`. The result
 * is an interval, not a number; compare with `epoch from age(...)`
 * or another `interval` for a numeric.
 *
 * ```ts
 * age(typedCol<Date>("born"))                                 // AGE("born")
 * age(typedCol<Date>("died"), typedCol<Date>("born"))          // AGE("died", "born")
 * ```
 *
 * **PG-only.** MySQL uses `TIMESTAMPDIFF(unit, start, end)` to get a
 * numeric in a chosen unit; MSSQL has `DATEDIFF(unit, start, end)`;
 * SQLite has `julianday()` differences. None of those return an
 * interval, so we don't surface a portable wrapper — the printer
 * refuses on the other dialects via `AGE_FN`.
 */
export function age(
  end: Expression<any> | Col<any>,
  start?: Expression<any> | Col<any>,
): Expression<unknown> {
  const endNode = end instanceof Col ? end._node : (end as Expression<any>).node
  const args: ExpressionNode[] = [endNode]
  if (start !== undefined) {
    args.push(start instanceof Col ? start._node : (start as Expression<any>).node)
  }
  return wrap<unknown>(rawFn("AGE", args))
}

/**
 * Calendar-interval unit accepted by {@link dateAdd} / {@link dateSub}.
 * The closed enum prevents typos and injection — every dialect's printer
 * maps the union member to its native unit keyword.
 */
export type DateIntervalUnit = "year" | "month" | "week" | "day" | "hour" | "minute" | "second"

const DATE_INTERVAL_UNITS: ReadonlySet<DateIntervalUnit> = new Set([
  "year",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
])

function buildDateInterval(
  fnName: "dateAdd" | "dateSub",
  expr: Expression<any> | Col<any>,
  amount: number,
  unit: DateIntervalUnit,
): Expression<Date> {
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new InvalidExpressionError(
      `${fnName}(): amount must be a finite integer, got ${String(amount)}.`,
    )
  }
  if (!DATE_INTERVAL_UNITS.has(unit)) {
    throw new InvalidExpressionError(
      `${fnName}(): unknown unit "${String(unit)}". Allowed: ${Array.from(DATE_INTERVAL_UNITS).join(", ")}.`,
    )
  }
  const exprNode = expr instanceof Col ? expr._node : (expr as Expression<any>).node
  const signedAmount = fnName === "dateSub" ? -amount : amount
  return wrap<Date>({
    type: "date_interval",
    expr: exprNode,
    amount: signedAmount,
    unit,
  })
}

/**
 * `dateAdd(expr, amount, unit)` — add a calendar interval to a date /
 * timestamp expression. Every dialect uses a different surface syntax;
 * sumak emits the right shape per dialect:
 *
 *  - PG:     `expr + INTERVAL '7 days'`
 *  - MySQL:  `DATE_ADD(expr, INTERVAL 7 DAY)`
 *  - MSSQL:  `DATEADD(day, 7, expr)`
 *  - SQLite: `datetime(expr, '+7 days')`
 *
 * ```ts
 * dateAdd(typedCol<Date>("created_at"), 7, "day")
 *   // PG:     "created_at" + INTERVAL '7 days'
 *   // MSSQL:  DATEADD(day, 7, [created_at])
 * ```
 *
 * `amount` may be negative; the builder forwards the sign as-is so PG's
 * `+ INTERVAL '-7 days'` and the MSSQL `DATEADD(day, -7, expr)` shapes
 * both work. For the symmetric subtraction-style call site, prefer
 * {@link dateSub} — it negates `amount` internally and makes the
 * caller's intent (subtract) explicit.
 *
 * `amount` is captured into the SQL text rather than parameterised: the
 * underlying engines use the literal as part of their plan-cache key
 * (PG, MSSQL) or string-format it at execution anyway (SQLite). The
 * builder rejects a non-integer / non-finite `amount` to keep injection
 * out of the picture; `unit` is a closed enum.
 */
export function dateAdd(
  expr: Expression<any> | Col<any>,
  amount: number,
  unit: DateIntervalUnit,
): Expression<Date> {
  return buildDateInterval("dateAdd", expr, amount, unit)
}

/**
 * `dateSub(expr, amount, unit)` — symmetric of {@link dateAdd} for the
 * subtraction direction. Compiles to the same `DateIntervalNode` shape
 * with a negated `amount`, so each dialect's printer renders the
 * appropriate native form:
 *
 *  - PG:     `expr - INTERVAL '7 days'`
 *  - MySQL:  `DATE_SUB(expr, INTERVAL 7 DAY)`  (DATE_ADD with negative also works; the printer picks DATE_SUB for positive amounts so the SQL reads naturally)
 *  - MSSQL:  `DATEADD(day, -7, expr)` (T-SQL has no `DATESUB`)
 *  - SQLite: `datetime(expr, '-7 days')`
 *
 * Use the same call shape as `dateAdd`; passing a negative amount to
 * `dateSub` adds back (rare but legal — it mirrors what `dateAdd(..,
 * -n, ..)` would emit).
 */
export function dateSub(
  expr: Expression<any> | Col<any>,
  amount: number,
  unit: DateIntervalUnit,
): Expression<Date> {
  return buildDateInterval("dateSub", expr, amount, unit)
}

/**
 * `NULLIF(a, b)` — returns NULL when `a = b`, otherwise `a`.
 * Common idiom for guarding against divide-by-zero:
 *
 * ```ts
 * .select({ ratio: div(col("hits"), nullif(col("total"), val(0))) })
 * // hits / NULLIF(total, 0) — division by NULL yields NULL, never an error
 * ```
 */
export function nullif<T>(a: Expression<T>, b: Expression<T>): Expression<T | null> {
  return wrap(rawFn("NULLIF", [(a as any).node, (b as any).node]))
}

/**
 * `GREATEST(a, b, …)` — variadic max-of. Minimum arity 2 (a single-
 * arg `GREATEST` is nonsensical, and the zero-arg form is rejected
 * by every dialect that supports the function).
 *
 * **NULL handling differs across dialects** (same as `concat`):
 * - PG / MSSQL: NULL arguments are **ignored** in the comparison.
 * - MySQL: NULL anywhere makes the whole expression NULL.
 * - SQLite: NULL counts as smaller than every value (i.e. ignored).
 *
 * Use `coalesce(x, val(0))` to neutralize NULLs portably.
 */
export function greatest<T>(...args: Expression<T>[]): Expression<T> {
  // Each dialect that supports GREATEST rejects the zero-arg form;
  // one-arg is technically legal on some but nonsensical.
  assertMinArity("greatest", args, 2)
  return wrap(
    rawFn(
      "GREATEST",
      args.map((a) => (a as any).node),
    ),
  )
}

/**
 * `LEAST(a, b, …)` — variadic min-of. Mirror of `greatest`; same
 * NULL caveats apply per-dialect.
 */
export function least<T>(...args: Expression<T>[]): Expression<T> {
  assertMinArity("least", args, 2)
  return wrap(
    rawFn(
      "LEAST",
      args.map((a) => (a as any).node),
    ),
  )
}

/**
 * `ABS(expr)` — absolute value. Standard SQL; supported on all four
 * dialects. NULL input produces NULL output.
 */
export function abs(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("ABS", [(expr as any).node]))
}

/**
 * `ROUND(expr [, precision])` — half-away-from-zero rounding by
 * default, but PG uses banker's rounding (half-to-even) and the
 * default precision differs across dialects. When the exact rounding
 * mode matters, multiply / divide explicitly instead of relying on
 * `ROUND`.
 *
 * Precision is a literal integer (positive → decimal places,
 * negative → tens / hundreds place).
 */
export function round(expr: Expression<number>, precision?: number): Expression<number> {
  const args: ExpressionNode[] = [(expr as any).node]
  if (precision !== undefined) args.push(rawLit(precision))
  return wrap(rawFn("ROUND", args))
}

/**
 * `CEIL(expr)` — smallest integer ≥ `expr`. The standard spells it
 * `CEILING`; PG / MySQL / SQLite accept both, MSSQL only accepts
 * `CEILING`. Use `sqlFn("CEILING", expr)` if cross-dialect MSSQL
 * support matters.
 */
export function ceil(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("CEIL", [(expr as any).node]))
}

/**
 * `TO_JSON(expr)` — convert any value to its JSON representation.
 * **PG-only**. MySQL emits the closest equivalent via
 * `CAST(expr AS JSON)`; SQLite has no equivalent.
 */
export function toJson<T>(expr: Expression<T>): Expression<unknown> {
  return wrap(rawFn("TO_JSON", [(expr as any).node]))
}

/** JSON_BUILD_OBJECT(key, value, ...) — build JSON object (PG) */
export function jsonBuildObject(
  ...pairs: [string, Expression<any>][]
): Expression<Record<string, unknown>> {
  // `JSON_BUILD_OBJECT()` with no args emits `'{}'::json` on PG — but
  // a builder call with zero pairs is almost always a logic bug (the
  // caller meant to populate it). Refuse at build time; the user can
  // always write `val('{}' as any)` if they really want an empty object.
  assertMinArity("jsonBuildObject", pairs, 1)
  const args: ExpressionNode[] = []
  for (const [key, val] of pairs) {
    args.push(rawLit(key))
    args.push((val as any).node)
  }
  return wrap(rawFn("JSON_BUILD_OBJECT", args))
}

// ── PostgreSQL array operators ──

/** @> (array contains) */
export function arrayContains(arr: Expression<any>, values: Expression<any>): Expression<boolean> {
  return wrap(binOp("@>", (arr as any).node, (values as any).node))
}

/** <@ (array contained by) */
export function arrayContainedBy(
  arr: Expression<any>,
  values: Expression<any>,
): Expression<boolean> {
  return wrap(binOp("<@", (arr as any).node, (values as any).node))
}

/** && (array overlaps) */
export function arrayOverlaps(arr: Expression<any>, values: Expression<any>): Expression<boolean> {
  return wrap(binOp("&&", (arr as any).node, (values as any).node))
}

/**
 * `ARRAY[e1, e2, …]` — PG-only array literal. The elements can be
 * any `Expression`, which lets callers mix parameterised values
 * (`val(1)`) with column refs and function calls. MySQL / SQLite /
 * MSSQL reject this at compile time via `printArrayExpr` overrides.
 *
 * ```ts
 * col.tags.eq(arrayLiteral([val("sql"), val("typescript")]))
 * col.id.eq(any(arrayLiteral([val(1), val(2), val(3)])))
 * ```
 */
export function arrayLiteral<T>(elements: Expression<T>[]): Expression<T[]> {
  return wrap({
    type: "array_expr",
    elements: elements.map((e) => (e as unknown as { node: ExpressionNode }).node),
  })
}

/**
 * `ANY(<subquery | array>)` — quantified comparison. Used as the
 * right-hand side of a comparison operator:
 *
 * ```ts
 * col.id.eq(any(db.selectFrom("admins").select("user_id")))
 * col.category.eq(any(arrayLiteral([val("a"), val("b")])))
 * col.id.eq(any(val([1, 2, 3])))  // array param
 * ```
 *
 * PG supports all forms. MySQL 8 supports the subquery form. MSSQL
 * and SQLite reject both at compile time via the feature matrix.
 */
export function any<T>(operand: Expression<T[]> | Expression<T>): Expression<T> {
  return buildQuantified<T>("ANY", operand)
}

/**
 * `ALL(<subquery | array>)` — quantified comparison. Matches when
 * the comparison holds for every row / element of the operand.
 */
export function all<T>(operand: Expression<T[]> | Expression<T>): Expression<T> {
  return buildQuantified<T>("ALL", operand)
}

/**
 * `SOME(...)` — PG's alias for `ANY`. Provided for parity with
 * hand-written SQL; semantically identical.
 */
export function some<T>(operand: Expression<T[]> | Expression<T>): Expression<T> {
  return buildQuantified<T>("SOME", operand)
}

/**
 * Build a `(VALUES (...)) AS alias(col1, col2, …)` derived-table
 * AST node. Every row must have the same number of elements as the
 * column-alias list — enforced here so mis-shaped data lights up at
 * build time, not at driver parse.
 *
 * ```ts
 * const seed = valuesClause({
 *   alias: "seed",
 *   columns: ["id", "name"],
 *   rows: [[val(1), val("Alice")], [val(2), val("Bob")]],
 * })
 * db.selectFrom(seed).selectAll()
 * ```
 */
export function valuesClause(args: {
  alias: string
  columns: readonly string[]
  rows: ReadonlyArray<ReadonlyArray<Expression<any>>>
}): ValuesClauseNode {
  if (args.rows.length === 0) {
    throw new InvalidExpressionError("valuesClause({ rows }) requires at least one row.")
  }
  const arity = args.columns.length
  if (arity === 0) {
    throw new InvalidExpressionError("valuesClause({ columns }) requires at least one column.")
  }
  for (const [i, row] of args.rows.entries()) {
    if (row.length !== arity) {
      throw new InvalidExpressionError(
        `valuesClause: row ${i} has ${row.length} values but columns list has ${arity}.`,
      )
    }
  }
  return {
    type: "values_clause",
    alias: args.alias,
    columnAliases: [...args.columns],
    rows: args.rows.map((row) => row.map((e) => (e as unknown as { node: ExpressionNode }).node)),
  }
}

/**
 * `GROUP BY GROUPING SETS ((a, b), (a), ())` — explicit
 * multi-dimensional grouping. Each entry of `sets` is a list of
 * grouping expressions evaluated together; an empty tuple inside
 * means "the grand-total row" (legal only here, not in CUBE /
 * ROLLUP).
 *
 * ```ts
 * db.selectFrom("sales")
 *   .select("region", "category", { total: sum(col("amount")) })
 *   .groupBy(groupingSets([
 *     [col("region"), col("category")],
 *     [col("region")],
 *     [],
 *   ]))
 * ```
 *
 * PG + MSSQL. SQLite and MySQL reject — use CUBE / ROLLUP
 * equivalents on SQLite, or write `WITH ROLLUP` via
 * `unsafeRawExpr` on MySQL.
 */
export function groupingSets(sets: ReadonlyArray<ReadonlyArray<GroupingItem>>): Expression<any> {
  return buildGrouping("grouping_sets", sets)
}

/**
 * `GROUP BY CUBE(a, b, …)` — all 2^n combinations of the grouping
 * columns. PG + MSSQL + SQLite 3.46+.
 */
export function cube(...cols: GroupingItem[]): Expression<any> {
  return buildGrouping("cube", [cols])
}

/**
 * `GROUP BY ROLLUP(a, b, …)` — hierarchical rollup from finest to
 * coarsest. PG + MSSQL + SQLite 3.46+ via the standard syntax. MySQL
 * users write the semantically-equivalent `... GROUP BY a, b WITH
 * ROLLUP` via `unsafeRawExpr`.
 */
export function rollup(...cols: GroupingItem[]): Expression<any> {
  return buildGrouping("rollup", [cols])
}

/**
 * Grouping-set builders accept any expression-shaped value — a sumak
 * `Expression<T>` (with a `.node`), a `Col<T>`, or a bare
 * `ExpressionNode` (`col("x")`'s direct return). We coerce them all
 * to `ExpressionNode` here so callers don't have to wrap/unwrap.
 */
type GroupingItem = Expression<any> | Col<any> | ExpressionNode

function groupingItemToNode(item: GroupingItem): ExpressionNode {
  if (item instanceof Col) return (item as Col<any>)._node
  if (isExpression(item)) return (item as Expression<any>).node
  return item as ExpressionNode
}

function buildGrouping(
  kind: "grouping_sets" | "cube" | "rollup",
  sets: ReadonlyArray<ReadonlyArray<GroupingItem>>,
): Expression<any> {
  if (sets.length === 0) {
    throw new InvalidExpressionError(
      `${kind === "grouping_sets" ? "groupingSets" : kind}() requires at least one group.`,
    )
  }
  if (kind !== "grouping_sets") {
    // CUBE / ROLLUP take a single flat list — the builder only
    // exposes variadic arg surfaces so this shouldn't hit authored
    // code. The guard catches hand-crafted AST misuse.
    if (sets[0]!.length === 0) {
      throw new InvalidExpressionError(`${kind}() requires at least one grouping expression.`)
    }
  }
  return wrap({
    type: "grouping",
    kind,
    sets: sets.map((s) => s.map(groupingItemToNode)),
  })
}

function buildQuantified<T>(
  quantifier: "ANY" | "ALL" | "SOME",
  operand: Expression<T[]> | Expression<T>,
): Expression<T> {
  const node = (operand as unknown as { node: ExpressionNode }).node
  // The AST constrains the operand to subquery | array_expr | param
  // | raw. Accept anything expression-shaped here; the printer
  // enforces the valid subset.
  if (
    node.type !== "subquery" &&
    node.type !== "array_expr" &&
    node.type !== "param" &&
    node.type !== "literal" &&
    node.type !== "raw"
  ) {
    throw new InvalidExpressionError(
      `${quantifier}(…) operand must be a subquery, array literal, or array param; got ${node.type}.`,
    )
  }
  return wrap<T>({ type: "quantified", quantifier, operand: node })
}

/**
 * `FLOOR(expr)` — largest integer ≤ `expr`. Standard SQL; supported
 * on all four dialects. NULL input produces NULL output.
 */
export function floor(expr: Expression<number>): Expression<number> {
  return wrap(rawFn("FLOOR", [(expr as any).node]))
}

/**
 * Row-value tuple for comparisons.
 *
 * ```ts
 * // (a, b) = (1, 2)
 * tuple(cols.a.toExpr(), cols.b.toExpr())
 * ```
 */
export function tuple(...exprs: Expression<any>[]): Expression<any> {
  // `()` is a syntax error across PG / MySQL / SQLite / MSSQL. A single-
  // element tuple emits `(x)` — equivalent to a parenthesized expression
  // and legal, so we allow it.
  assertMinArity("tuple", exprs, 1)
  const node: TupleNode = {
    type: "tuple",
    elements: exprs.map((e) => (e as any).node),
  }
  return wrap(node)
}
