import type {
  ArrayExprNode,
  BinaryOpNode,
  CTENode,
  DateIntervalNode,
  DeleteNode,
  FrameSpec,
  FullTextSearchNode,
  FunctionCallNode,
  InsertNode,
  JsonAccessNode,
  LiteralNode,
  MergeNode,
  OrderByNode,
  QuantifiedExprNode,
  SelectNode,
  UpdateNode,
  WindowFunctionNode,
} from "../ast/nodes.ts"
import { MSSQL_ACTION_FUNCTION_NAME } from "../builder/eb.ts"
import { assertFeature } from "../dialect/features.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { quoteIdentifier } from "../utils/identifier.ts"
import { BasePrinter } from "./base.ts"

export class MssqlPrinter extends BasePrinter {
  constructor() {
    super("mssql")
  }

  protected override printSelect(node: SelectNode): string {
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    if (node.distinctOn) {
      assertFeature("mssql", "DISTINCT_ON")
    }

    // SQL Server supports OVER but not the SQL:2003 named `WINDOW` clause —
    // there's no way to register a reusable window spec on a SELECT. Reject
    // both halves of the feature with a single error pointing at the
    // workaround (repeat the spec inline on each OVER).
    if (node.windows && node.windows.length > 0) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "named WINDOW clause (SQL Server has no `WINDOW name AS (...)` — repeat the spec inline on each OVER(...))",
      )
    }

    parts.push("SELECT")

    if (node.distinct) {
      parts.push("DISTINCT")
    }

    // MSSQL: TOP N instead of LIMIT (only when no OFFSET and no set-op).
    // `SELECT TOP 10 ... UNION SELECT ...` applies TOP only to the left
    // arm on SQL Server — silently returns fewer rows than the user
    // expected. For UNION with a limit, the outer query uses
    // `OFFSET 0 ROWS FETCH NEXT N ROWS ONLY` instead; when there's no
    // set-op we still prefer the shorter `TOP N` form.
    if (node.limit && !node.offset && !node.setOp) {
      parts.push(`TOP ${this.printExpression(node.limit)}`)
    }

    if (node.columns.length === 0) {
      parts.push("*")
    } else {
      parts.push(node.columns.map((c) => this.printExpression(c)).join(", "))
    }

    if (node.from) {
      parts.push("FROM")
      if (node.from.type === "subquery") {
        parts.push(this.printSubquery(node.from))
      } else if (node.from.type === "graph_table") {
        parts.push(this.printGraphTable(node.from))
      } else if (node.from.type === "values_clause") {
        parts.push(this.printValuesClause(node.from))
      } else {
        parts.push(this.printTableRef(node.from))
      }
    }

    for (const join of node.joins) {
      parts.push(this.printJoin(join))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    if (node.groupBy.length > 0) {
      parts.push("GROUP BY", node.groupBy.map((g) => this.printExpression(g)).join(", "))
    }

    if (node.having) {
      parts.push("HAVING", this.printExpression(node.having))
    }

    // MSSQL: UNION / INTERSECT / EXCEPT come between HAVING and ORDER BY —
    // the outer query's ORDER BY + OFFSET/FETCH apply to the combined
    // result, not to the left arm. Emitting OFFSET/FETCH before the
    // set-op was invalid SQL (SQL Server rejects the statement).
    if (node.setOp) {
      // Wrap the inner SELECT in parens when it carries its own
      // ORDER BY / OFFSET / FETCH (LIMIT) — without parens those
      // clauses bind to the combined result on SQL Server, not to
      // the inner arm, silently changing what the caller asked for.
      const inner = node.setOp.query
      const innerHasPagination =
        inner.orderBy.length > 0 || inner.limit !== undefined || inner.offset !== undefined
      const printedInner = this.printSelect(inner)
      parts.push(node.setOp.op, innerHasPagination ? `(${printedInner})` : printedInner)
    }

    if (node.orderBy.length > 0) {
      parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
    }

    // MSSQL: OFFSET/FETCH instead of LIMIT/OFFSET (requires ORDER BY).
    // When a set-op is present we couldn't emit TOP (it would bind to the
    // left arm only), so any `.limit()` must land here as a FETCH clause
    // even without an explicit OFFSET.
    // Treat literal-zero offset as "no pagination": `.offset(0)` as a
    // no-op (for a stable pagination API across dialects) should not
    // force an ORDER BY requirement when no LIMIT is present.
    const isZeroOffset =
      node.offset?.type === "literal" && (node.offset as { value: unknown }).value === 0
    const needsOffsetFetch =
      (node.offset && !(isZeroOffset && !node.limit)) || (node.limit && node.setOp)
    if (needsOffsetFetch) {
      if (node.orderBy.length === 0) {
        throw new UnsupportedDialectFeatureError(
          "mssql",
          "OFFSET/FETCH requires ORDER BY on SQL Server — add .orderBy(...) before .offset()/.limit()",
        )
      }
      const off = node.offset ?? { type: "literal" as const, value: 0 }
      parts.push(`OFFSET ${this.printExpression(off)} ROWS`)
      if (node.limit) {
        parts.push(`FETCH NEXT ${this.printExpression(node.limit)} ROWS ONLY`)
      }
    }

    if (node.lock) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "FOR UPDATE/SHARE (use WITH (UPDLOCK) hints instead)",
      )
    }

    return parts.join(" ")
  }

  /**
   * SQL Server supports recursive CTEs but does not accept the
   * `RECURSIVE` keyword — `WITH cte AS (...)` is used for both recursive
   * and non-recursive CTEs. Emitting `WITH RECURSIVE` is a syntax error.
   */
  protected override printCTEs(ctes: CTENode[]): string {
    const cteParts = ctes.map(
      (c) => `${quoteIdentifier(c.name, this.dialect)} AS (${this.printSelect(c.query)})`,
    )
    return `WITH ${cteParts.join(", ")}`
  }

  /**
   * SQL Server has no boolean type — `TRUE` / `FALSE` are not literals,
   * they are identifiers (and unbound ones). Boolean literals must be
   * emitted as `1` / `0` (the BIT domain). Every path that routes
   * through `printLiteral` (bare `lit(true)`, `IS NOT DISTINCT FROM
   * true`, `CASE WHEN … THEN true`, etc.) otherwise produces
   * unexecutable SQL.
   */
  protected override printLiteral(node: LiteralNode): string {
    if (typeof node.value === "boolean") return node.value ? "1" : "0"
    return super.printLiteral(node)
  }

  /**
   * SQL Server has no `EXPLAIN` keyword; query plans are obtained via
   * session-scoped `SET SHOWPLAN_ALL ON` (text plan) / `SET STATISTICS
   * PROFILE ON` (runtime stats). Neither is a prefix on the statement,
   * so there's no clean translation — refuse with a pointer.
   */
  protected override printExplain(_node: import("../ast/nodes.ts").ExplainNode): string {
    throw new UnsupportedDialectFeatureError(
      "mssql",
      "EXPLAIN (SQL Server uses session-scoped SET SHOWPLAN_ALL ON or SET STATISTICS PROFILE ON — emit those separately)",
    )
  }

  /**
   * SQL Server has no `->` / `->>` / `#>` / `#>>` operators — it uses
   * `JSON_VALUE(expr, '$.path')` for scalar extraction and
   * `JSON_QUERY(expr, '$.path')` for JSON-typed extraction. The base
   * printer would otherwise emit PG operators verbatim; the driver
   * rejects the statement at parse. Rather than silently translate
   * (the two forms differ on array-vs-scalar semantics), reject with
   * a message pointing at the right MSSQL function.
   */
  protected override printJsonAccess(_node: JsonAccessNode): string {
    throw new UnsupportedDialectFeatureError(
      "mssql",
      "JSON path operators (->, ->>, #>, #>>) — use JSON_VALUE(expr, '$.path') for scalars or JSON_QUERY(expr, '$.path') for objects/arrays via sql`…`",
    )
  }

  protected override printGraphTable(
    _node: import("../ast/graph-nodes.ts").GraphTableNode,
  ): string {
    throw new UnsupportedDialectFeatureError(
      "mssql",
      "SQL:2023 GRAPH_TABLE (MSSQL has its own node/edge MATCH() graph syntax — not the SQL/PGQ standard)",
    )
  }

  /**
   * MSSQL does not support `LATERAL` — it has `CROSS APPLY` / `OUTER
   * APPLY` which are semantically similar but syntactically different.
   * Throw rather than silently emit invalid SQL; users who need the
   * correlated-subquery pattern on MSSQL should use raw SQL for now.
   */
  protected override printJoin(node: import("../ast/nodes.ts").JoinNode): string {
    if (node.lateral) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "LATERAL JOIN (use CROSS APPLY / OUTER APPLY via raw SQL)",
      )
    }
    return super.printJoin(node)
  }

  /**
   * SQL Server supports OVER but rejects `OVER <name>` (the named-window
   * reference form). The matching `WINDOW` clause is also unavailable —
   * `printSelect` rejects a non-empty `windows` slot already, but a
   * stray `WindowFunctionNode.windowName` in a subquery / CTE wouldn't
   * pass through that guard. Reject here too.
   */
  protected override printWindowFunction(node: WindowFunctionNode): string {
    if (node.windowName !== undefined) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "named WINDOW reference (`OVER <name>` — SQL Server requires the spec inline on each OVER(...))",
      )
    }
    return super.printWindowFunction(node)
  }

  /**
   * SQL Server has no SQL:2011 `EXCLUDE` frame clause; the parser
   * rejects `EXCLUDE { CURRENT ROW | GROUP | TIES | NO OTHERS }`
   * outright. Refuse at print time via the `FRAME_EXCLUDE` feature
   * flag rather than emitting invalid SQL.
   */
  protected override printFrameSpec(frame: FrameSpec): string {
    if (frame.exclude !== undefined) {
      assertFeature("mssql", "FRAME_EXCLUDE")
    }
    return super.printFrameSpec(frame)
  }

  protected override printInsert(node: InsertNode): string {
    if (node.onConflict) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "ON CONFLICT (use MERGE for upsert in MSSQL)",
      )
    }
    if (node.insertMode && node.insertMode !== "INSERT") {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        `${node.insertMode} (SQLite-only syntax — use MERGE INTO for MSSQL upserts)`,
      )
    }
    if (node.overriding) {
      // MSSQL has no inline `OVERRIDING` clause. The closest analogue
      // is `SET IDENTITY_INSERT <table> ON`, but that's a separate
      // statement with session-scoped state — silently rewriting one
      // into the other would surprise callers.
      assertFeature("mssql", "INSERT_OVERRIDING")
    }

    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("INSERT INTO", this.printTableRef(node.table))

    if (node.columns.length > 0) {
      parts.push(`(${node.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")})`)
    }

    // MSSQL: OUTPUT instead of RETURNING
    if (node.returning.length > 0) {
      parts.push("OUTPUT", this._outputCols(node.returning, "INSERTED"))
    }

    if (node.defaultValues) {
      parts.push("DEFAULT VALUES")
    } else if (node.source) {
      parts.push(this.printSelect(node.source))
    } else {
      parts.push("VALUES")
      const rows = node.values.map(
        (row) => `(${row.map((v) => this.printExpression(v)).join(", ")})`,
      )
      parts.push(rows.join(", "))
    }

    return parts.join(" ")
  }

  protected override printUpdate(node: UpdateNode): string {
    // SQL Server does not support UPDATE ... ORDER BY / LIMIT directly;
    // silently dropping either (as the base printer's inherited behavior
    // would) emits a much more permissive statement than the caller
    // wrote — an UPDATE intended to bound rows modifies the entire
    // matched set. Reject explicitly with a CTE/TOP-shaped hint.
    if (node.limit || (node.orderBy && node.orderBy.length > 0)) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "UPDATE with LIMIT/ORDER BY — use a CTE: WITH cte AS (SELECT TOP N ... ORDER BY ...) UPDATE cte SET ...",
      )
    }
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("UPDATE", this.printTableRef(node.table), "SET")

    const sets = node.set.map(
      (s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`,
    )
    parts.push(sets.join(", "))

    // MSSQL: OUTPUT instead of RETURNING
    if (node.returning.length > 0) {
      parts.push("OUTPUT", this._outputCols(node.returning, "INSERTED"))
    }

    // MSSQL `UPDATE t SET ... FROM t INNER JOIN ... WHERE`: FROM precedes JOINs.
    if (node.from) {
      parts.push("FROM", this.printTableRef(node.from))
    }

    for (const join of node.joins) {
      parts.push(this.printJoin(join))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    return parts.join(" ")
  }

  protected override printDelete(node: DeleteNode): string {
    if (node.limit || (node.orderBy && node.orderBy.length > 0)) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "DELETE with LIMIT/ORDER BY — use a CTE: WITH cte AS (SELECT TOP N ... ORDER BY ...) DELETE FROM cte",
      )
    }
    if (node.using) {
      // MSSQL has no `DELETE FROM t USING other`; multi-table form is
      // `DELETE t FROM t JOIN other …`. Point the caller at innerJoin
      // rather than silently emitting PG-flavoured invalid SQL.
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "DELETE ... USING (use .innerJoin(other, on) — SQL Server multi-table form is `DELETE t FROM t JOIN other`)",
      )
    }
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    // MSSQL multi-table DELETE: `DELETE <target> FROM <target> <joins>`.
    // The target alias (or bare name) precedes FROM; the base printer's
    // `DELETE FROM t INNER JOIN …` form is a MSSQL parse error.
    if (node.joins.length > 0) {
      const tableName = node.table.alias ?? node.table.name
      parts.push("DELETE", quoteIdentifier(tableName, this.dialect))
      // MSSQL: OUTPUT sits between target and FROM on delete-with-join.
      if (node.returning.length > 0) {
        parts.push("OUTPUT", this._outputCols(node.returning, "DELETED"))
      }
      parts.push("FROM", this.printTableRef(node.table))
      for (const join of node.joins) parts.push(this.printJoin(join))
      if (node.where) parts.push("WHERE", this.printExpression(node.where))
      return parts.join(" ")
    }

    parts.push("DELETE FROM", this.printTableRef(node.table))

    // MSSQL: OUTPUT instead of RETURNING
    if (node.returning.length > 0) {
      parts.push("OUTPUT", this._outputCols(node.returning, "DELETED"))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    return parts.join(" ")
  }

  /**
   * Render a RETURNING list as MSSQL `OUTPUT` columns under the given
   * pseudo-table (`INSERTED` or `DELETED`). Handles `StarNode` bare and
   * table-qualified — the pseudo-tables are fixed names, so a user's
   * `returning(star("orders"))` (meaning "all columns of orders") maps
   * to `INSERTED.*` (the pseudo-table has every column of the target).
   * Emitting `INSERTED.[orders].*` produces an invalid three-part name
   * that SQL Server rejects at parse.
   *
   * Column refs that already carry an explicit `INSERTED` / `DELETED`
   * table qualifier (case-insensitive) pass through unchanged so the
   * user can override the default prefix on a per-column basis. This
   * is rare for plain INSERT/UPDATE/DELETE (where exactly one of the
   * pseudo-tables is meaningful) but essential for MERGE.
   */
  private _outputCols(
    returning: readonly import("../ast/nodes.ts").ExpressionNode[],
    prefix: "INSERTED" | "DELETED",
  ): string {
    return returning
      .map((r) => {
        if (r.type === "star") {
          // Drop any user-supplied table qualifier: OUTPUT targets the
          // INSERTED/DELETED pseudo-table, never the base table directly.
          return `${prefix}.*`
        }
        if (r.type === "column_ref" && this._isPseudoTablePrefix(r.table)) {
          // User-specified `inserted.col` / `deleted.col` — preserve
          // their choice rather than double-prefixing.
          return this.printExpression(r)
        }
        return `${prefix}.${this.printExpression(r)}`
      })
      .join(", ")
  }

  /**
   * `OUTPUT` projection for MERGE — unlike INSERT/UPDATE/DELETE, both
   * pseudo-tables (`INSERTED` for UPDATE/INSERT branches, `DELETED`
   * for DELETE/UPDATE-old branches) are simultaneously in scope. Bare
   * column refs default to `INSERTED.` (the post-action row, the most
   * common case for "what did MERGE produce?"); users who want the
   * pre-action row pass a column ref with an explicit `"DELETED"` table
   * qualifier. The `$action` literal (via the dedicated
   * `mergeActionMssql()` builder helper) projects which branch fired,
   * analogous to PG's `merge_action()`.
   */
  private _mergeOutputCols(returning: readonly import("../ast/nodes.ts").ExpressionNode[]): string {
    return returning
      .map((r) => {
        if (r.type === "star") {
          // Star without an explicit pseudo-table on MERGE defaults
          // to `INSERTED.*` — the post-action row. `DELETED.*` is
          // reachable via `star("DELETED")` if the user wants it.
          if (this._isPseudoTablePrefix(r.table)) {
            return `${r.table!.toUpperCase()}.*`
          }
          return "INSERTED.*"
        }
        if (r.type === "column_ref" && this._isPseudoTablePrefix(r.table)) {
          return this.printExpression(r)
        }
        if (r.type === "column_ref") {
          // Bare `col("id")` on MERGE OUTPUT — prefix with INSERTED.
          // Re-emit the column ref via printExpression (so identifier
          // quoting + any alias still apply) but with INSERTED prepended.
          return `INSERTED.${this.printExpression(r)}`
        }
        // Non-column expressions — raw nodes (`$action`), function calls,
        // aliased exprs, etc. — print verbatim. The user is responsible
        // for picking a valid OUTPUT projection (e.g. `INSERTED.col + 1`
        // via `unsafeRawExpr` is fine; bare `col("id") + 1` from a
        // typed builder would compile to `("id" + 1)` which SQL Server
        // rejects in OUTPUT scope, but that's a builder-side concern).
        return this.printExpression(r)
      })
      .join(", ")
  }

  /**
   * True when a table qualifier names one of MSSQL's MERGE/OUTPUT
   * pseudo-tables (`inserted` / `deleted`, case-insensitive). Used to
   * suppress the automatic INSERTED-prefix injection when the user
   * has already specified the pseudo-table on the column ref.
   */
  private _isPseudoTablePrefix(table: string | undefined): boolean {
    if (!table) return false
    const upper = table.toUpperCase()
    return upper === "INSERTED" || upper === "DELETED"
  }

  protected override printFullTextSearch(node: FullTextSearchNode): string {
    const cols = node.columns.map((c) => this.printExpression(c)).join(", ")
    const query = this.printExpression(node.query)
    const fn = node.mode === "natural" ? "FREETEXT" : "CONTAINS"
    let result = `${fn}((${cols}), ${query})`
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }

  /**
   * MSSQL has no standard `NULLS FIRST / LAST` — SQL Server 2022 added
   * a variant but widely-deployed versions don't support it. Refuse
   * rather than emit invalid SQL; callers can use a CASE expression
   * or `ISNULL(col, ...)` as a secondary sort key instead.
   */
  protected override printOrderBy(node: OrderByNode): string {
    if (node.nulls) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "NULLS FIRST/LAST in ORDER BY (use a CASE expression as a secondary sort key)",
      )
    }
    return super.printOrderBy(node)
  }

  /**
   * MSSQL has no `IS [NOT] DISTINCT FROM` pre-2022 and no `ILIKE`.
   * Refuse; callers can rewrite via `CASE WHEN ... IS NULL THEN ...`
   * or `COLLATE` clauses respectively.
   */
  protected override printBinaryOp(node: BinaryOpNode): string {
    if (node.op === "IS DISTINCT FROM" || node.op === "IS NOT DISTINCT FROM") {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        `${node.op} (MSSQL pre-2022 has no equivalent — use CASE WHEN with IS NULL guards)`,
      )
    }
    if (node.op === "ILIKE" || node.op === "NOT ILIKE") {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        `${node.op} (use LIKE with a case-insensitive COLLATE clause)`,
      )
    }
    return super.printBinaryOp(node)
  }

  /**
   * SQL Server does not support `<agg> FILTER (WHERE ...)`. Rewriting to
   * `COUNT(CASE WHEN ... END)` changes NULL-handling subtly (COUNT skips
   * nulls; the CASE produces nulls), so we refuse and point the caller
   * at an explicit rewrite.
   */
  protected override printFunctionCall(node: FunctionCallNode): string {
    // `mergeActionMssql()` produces a function_call with a sentinel
    // name; we rewrite it here to SQL Server's `$action` pseudo-column
    // (no parens — it's not a callable function, it's a positional
    // marker the MERGE OUTPUT clause expands at execution time). The
    // sentinel name is chosen so it would NEVER collide with a real
    // user-supplied function — collision would silently produce
    // `$action` instead of the user's function call. We still let an
    // optional alias propagate so `mergeActionMssql().as("kind")`
    // (when wired into the typed builder's aliased-object form)
    // would render correctly.
    if (node.name === MSSQL_ACTION_FUNCTION_NAME) {
      let result = "$action"
      if (node.alias) {
        result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
      }
      return result
    }
    // MSSQL has no `POSITION(needle IN haystack)` form. The native
    // equivalent is `CHARINDEX(needle, haystack)`, which has the same
    // 1-based result and 0 on a miss. Rewrite the marked node into a
    // regular function call so the base printer emits the comma form
    // without the IN keyword. Arg order matches POSITION's
    // (needle, haystack) — CHARINDEX uses the same.
    if (node.isPositionCall) {
      return super.printFunctionCall({
        ...node,
        name: "CHARINDEX",
        isPositionCall: false,
      })
    }
    if (node.filter) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "FILTER (WHERE ...) aggregate clause (rewrite as COUNT(CASE WHEN ... THEN 1 END) or SUM(CASE ...))",
      )
    }
    // SQL Server's `JSON_VALUE` always returns nvarchar(4000); it has
    // no `RETURNING <type>` clause and the parser rejects it. Refuse
    // with a pointer at the CAST workaround. Bare `JSON_VALUE(json,
    // '$.path')` is fine and passes through.
    if (node.returningType !== undefined) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "JSON_VALUE ... RETURNING type (SQL Server's JSON_VALUE always returns nvarchar — wrap with CAST(JSON_VALUE(...) AS type))",
      )
    }
    const upper = node.name.toUpperCase()
    // MSSQL has `DATETRUNC` (one word, SQL Server 2022+) with a
    // different shape — the field is an identifier, not a string
    // literal. Refuse PG's `DATE_TRUNC` rather than silently rewrite
    // (rewrite would still emit the wrong arg type pre-2022) so the
    // failure points at the builder.
    if (upper === "DATE_TRUNC") {
      assertFeature("mssql", "DATE_TRUNC_FN")
    }
    // MSSQL has no `AGE`. The interval-difference idiom is
    // `DATEDIFF(unit, start, end)`, which returns a numeric instead of
    // an interval — different semantics. Refuse the standard name.
    if (upper === "AGE") {
      assertFeature("mssql", "AGE_FN")
    }
    // MSSQL's T-SQL spellings are `STDEV` / `STDEVP` / `VAR` / `VARP`
    // — there is no `STDDEV`, `STDDEV_POP`, `STDDEV_SAMP`, `VARIANCE`,
    // `VAR_POP`, or `VAR_SAMP` built-in. Emitting the standard name
    // would produce SQL the engine rejects at parse time. Refuse via
    // the feature flag and point the caller at the T-SQL names through
    // `sqlFn("STDEV", expr)` / `sqlFn("STDEVP", expr)` / `sqlFn("VAR",
    // expr)` / `sqlFn("VARP", expr)`.
    if (upper === "STDDEV" || upper === "STDDEV_POP" || upper === "STDDEV_SAMP") {
      assertFeature("mssql", "STDDEV_FN")
    }
    if (upper === "VARIANCE" || upper === "VAR_POP" || upper === "VAR_SAMP") {
      assertFeature("mssql", "VARIANCE_FN")
    }
    // MSSQL has no built-in linear-regression aggregates (`CORR`,
    // `COVAR_POP`, `COVAR_SAMP`, `REGR_*`). The pieces can be
    // hand-rolled from SUM/AVG with the variance/covariance identities
    // but with worse numerical stability. Refuse rather than emit a
    // function the engine doesn't know.
    if (
      upper === "CORR" ||
      upper === "COVAR_POP" ||
      upper === "COVAR_SAMP" ||
      upper === "REGR_SLOPE" ||
      upper === "REGR_INTERCEPT" ||
      upper === "REGR_R2"
    ) {
      assertFeature("mssql", "LINEAR_REGRESSION_AGG")
    }
    // MSSQL has no native regex functions at all — `LIKE` is a glob,
    // and the closest thing in T-SQL is the (separate) CLR-hosted
    // user function or the SQL Server 2025+ preview of regex
    // functions. Refuse all four standard names so the failure
    // points at the builder, not a generic "no such function" at
    // execution.
    if (upper === "REGEXP_REPLACE") {
      assertFeature("mssql", "REGEXP_REPLACE_FN")
    }
    if (upper === "REGEXP_LIKE") {
      assertFeature("mssql", "REGEXP_LIKE_FN")
    }
    if (upper === "REGEXP_MATCHES") {
      assertFeature("mssql", "REGEXP_MATCHES_FN")
    }
    if (upper === "REGEXP_SUBSTR") {
      assertFeature("mssql", "REGEXP_SUBSTR_FN")
    }
    // SQLite/MSSQL `LOG` semantics:
    // - PG / SQLite (3.35+): `log(x)` is base-10
    // - MySQL / MSSQL: `LOG(x)` is natural log; `LOG10(x)` is base-10
    //
    // sumak's `log(x)` builder is documented as base-10 across all
    // dialects. Rewrite `LOG(x)` → `LOG10(x)` on MSSQL so the
    // user-visible semantics stays portable. The two-arg LOG form
    // isn't exposed by the builder (its dialect ambiguity is
    // documented in eb.ts), so a 1-arg call is the only path here.
    if (upper === "LOG" && node.args.length === 1) {
      return super.printFunctionCall({ ...node, name: "LOG10" })
    }
    // MSSQL has no `LN` keyword — its `LOG(x)` is the natural log. Map
    // the standard-name `LN` to `LOG` so the builder call works
    // portably without surfacing a "no such function" parse error.
    if (upper === "LN") {
      return super.printFunctionCall({ ...node, name: "LOG" })
    }
    if (upper === "PI" && node.args.length === 0) {
      assertFeature("mssql", "PI_FN")
    }
    if (
      upper === "SIN" ||
      upper === "COS" ||
      upper === "TAN" ||
      upper === "DEGREES" ||
      upper === "RADIANS"
    ) {
      assertFeature("mssql", "TRIGONOMETRY_FNS")
    }
    // MSSQL has no first-class array type. The PG array helpers either
    // don't exist or would silently match a user-defined function with
    // the same name. Refuse via the single `PG_ARRAY_FNS` flag so the
    // failure points at the builder call. The closest MSSQL idiom is
    // table-valued parameters or OPENJSON projection, neither of which
    // is interchangeable with PG's array shape.
    if (
      upper === "ARRAY_APPEND" ||
      upper === "ARRAY_PREPEND" ||
      upper === "ARRAY_CAT" ||
      upper === "ARRAY_LENGTH" ||
      upper === "ARRAY_POSITIONS" ||
      upper === "ARRAY_POSITION" ||
      upper === "ARRAY_REMOVE" ||
      upper === "ARRAY_REPLACE" ||
      upper === "ARRAY_TO_STRING" ||
      upper === "UNNEST"
    ) {
      assertFeature("mssql", "PG_ARRAY_FNS")
    }
    // MSSQL has no `BIT_AND` / `BIT_OR` / `BIT_XOR` aggregates — T-SQL
    // exposes only the per-row bitwise operators (`&`, `|`, `^`), no
    // multi-row reduction. Refuse via the dedicated flags so the failure
    // points at the builder.
    if (upper === "BIT_AND" || upper === "BIT_OR") {
      assertFeature("mssql", "BIT_AGGREGATES")
    }
    if (upper === "BIT_XOR") {
      assertFeature("mssql", "BIT_XOR_AGG")
    }
    // MSSQL has no `BOOL_AND` / `BOOL_OR` aggregates. Booleans round-
    // trip as `bit` in T-SQL; the portable workaround is
    // `MIN(CAST(b AS int))` / `MAX(CAST(b AS int))`. Refuse with a
    // pointer at the workaround.
    if (upper === "BOOL_AND" || upper === "BOOL_OR") {
      assertFeature("mssql", "BOOL_AGGREGATES")
    }
    // MSSQL has no `NTH_VALUE` window function. `FIRST_VALUE` and
    // `LAST_VALUE` exist and pass through; `NTH_VALUE` refuses via the
    // dedicated flag.
    if (upper === "NTH_VALUE") {
      assertFeature("mssql", "NTH_VALUE_FN")
    }
    return super.printFunctionCall(node)
  }

  /** MSSQL has no `ARRAY[...]` literal syntax. */
  protected override printArrayExpr(_node: ArrayExprNode): string {
    throw new UnsupportedDialectFeatureError(
      "mssql",
      "ARRAY[...] literal (MSSQL has no array literal — use OPENJSON / table values)",
    )
  }

  /** MSSQL has no ANY/ALL quantified comparison. */
  protected override printQuantified(_node: QuantifiedExprNode): string {
    assertFeature("mssql", "QUANTIFIED_SUBQUERY")
    return "" // unreachable — assertFeature throws
  }

  /**
   * MSSQL: `DATEADD(<datepart>, <number>, <date>)`. T-SQL has no
   * `DATESUB` — the convention is to pass a negative `number` to
   * `DATEADD` for the subtraction case. The datepart is an
   * identifier (not a string literal); the closed `DateIntervalUnit`
   * enum already constrains it to the dialect-recognised set.
   */
  protected override printDateInterval(node: DateIntervalNode): string {
    const inner = `DATEADD(${node.unit}, ${node.amount}, ${this.printExpression(node.expr)})`
    return node.alias ? `${inner} AS ${quoteIdentifier(node.alias, this.dialect)}` : inner
  }

  /**
   * MSSQL's MERGE has an `OUTPUT` clause for the same purpose as PG's
   * `RETURNING` — the AST stores both via `MergeNode.returning`. At
   * print time we rewrite the tail: PG emits `RETURNING <cols>`, MSSQL
   * emits `OUTPUT <cols>` with the `INSERTED` / `DELETED` pseudo-tables
   * the dialect requires.
   *
   * Pseudo-table conventions: bare column refs (`col("id")`) default
   * to `INSERTED.id` (the post-action row). Users who want the
   * pre-action row pass `col("id", "DELETED")`. The `$action` token
   * (`'INSERT' | 'UPDATE' | 'DELETE'`) is produced by the dedicated
   * `mergeActionMssql()` builder helper — distinct from PG's
   * `mergeAction()` because the two compile to different syntax
   * (`MERGE_ACTION()` is a function, `$action` is a pseudo-column).
   *
   * Positioning: SQL Server's grammar puts `OUTPUT` between the last
   * `WHEN` clause and the (mandatory) closing semicolon — we emit
   * everything up to and including the WHENs via the base printer,
   * then append `OUTPUT <cols>`. Other MSSQL-specific MERGE
   * requirements (the trailing `;`) are the driver's job, not the
   * printer's; SQL Server tolerates the missing semicolon at parse
   * but the standard practice is to add one externally.
   */
  protected override printMerge(node: MergeNode): string {
    if (node.returning.length === 0) {
      return super.printMerge(node)
    }
    assertFeature("mssql", "MERGE_RETURNING")
    // Print the rest of the statement via the base printer with an
    // empty returning slot, then append the MSSQL-flavored OUTPUT
    // tail. This keeps the base printer the single source of truth
    // for the MERGE skeleton (target / source / ON / WHENs / CTEs)
    // and avoids duplicating that logic.
    const baseSql = super.printMerge({ ...node, returning: [] })
    return `${baseSql} OUTPUT ${this._mergeOutputCols(node.returning)}`
  }
}
