import type {
  ArrayExprNode,
  BinaryOpNode,
  DateIntervalNode,
  DeleteNode,
  FrameSpec,
  FullTextSearchNode,
  FunctionCallNode,
  InsertNode,
  JoinNode,
  OrderByNode,
  QuantifiedExprNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { assertFeature } from "../dialect/features.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { quoteIdentifier } from "../utils/identifier.ts"
import { escapeStringLiteral } from "../utils/security.ts"
import { BasePrinter } from "./base.ts"

export class MysqlPrinter extends BasePrinter {
  constructor() {
    super("mysql")
  }

  protected override printInsert(node: InsertNode): string {
    if (node.returning.length > 0) {
      assertFeature("mysql", "RETURNING")
    }
    if (node.ctes.some((c) => c.recursive)) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "WITH RECURSIVE in INSERT (MySQL allows recursive CTEs only in SELECT)",
      )
    }
    if (node.onConflict) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "ON CONFLICT (use onDuplicateKeyUpdate for MySQL)",
      )
    }
    if (node.insertMode && node.insertMode !== "INSERT") {
      // `INSERT OR IGNORE/REPLACE/…` is SQLite syntax. MySQL has
      // `INSERT IGNORE` / `REPLACE INTO` / `ON DUPLICATE KEY UPDATE`,
      // but the shapes are different enough that silent rewriting
      // would surprise callers. Refuse and point at the MySQL path.
      throw new UnsupportedDialectFeatureError(
        "mysql",
        `${node.insertMode} (SQLite-only syntax — use onDuplicateKeyUpdate, or raw \`INSERT IGNORE\` via sql.unsafe)`,
      )
    }
    if (node.overriding) {
      // MySQL has no `OVERRIDING` clause. AUTO_INCREMENT columns
      // accept user values directly, so this clause is also semantically
      // unnecessary — refuse with a hint rather than silently emit it.
      assertFeature("mysql", "INSERT_OVERRIDING")
    }

    let sql = super.printInsert(node)

    if (node.onDuplicateKeyUpdate && node.onDuplicateKeyUpdate.length > 0) {
      const sets = node.onDuplicateKeyUpdate
        .map((s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`)
        .join(", ")
      sql += ` ON DUPLICATE KEY UPDATE ${sets}`
    }

    return sql
  }

  protected override printSelect(node: SelectNode): string {
    if (node.distinctOn) {
      assertFeature("mysql", "DISTINCT_ON")
    }
    // MySQL 8.0 supports `FOR UPDATE` and `FOR SHARE` only. PG's finer-
    // grained lock modes (`NO KEY UPDATE`, `KEY SHARE`) are unknown to
    // MySQL — the base printer would emit `FOR NO KEY UPDATE` verbatim
    // and the server would reject it at parse. Point the caller at
    // the supported forms.
    if (node.lock && node.lock.mode !== "UPDATE" && node.lock.mode !== "SHARE") {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        `FOR ${node.lock.mode} — MySQL supports only FOR UPDATE and FOR SHARE; use .forUpdate() or .forShare()`,
      )
    }
    return super.printSelect(node)
  }

  /**
   * MySQL multi-table UPDATE: `UPDATE t [JOIN t2 ON …] SET … WHERE …`.
   * There is no `FROM` clause — JOINs follow the target table directly.
   * If a caller used `.from()` with a MySQL dialect, surface a helpful error
   * instead of silently emitting invalid SQL.
   */
  protected override printUpdate(node: UpdateNode): string {
    if (node.returning.length > 0) {
      assertFeature("mysql", "RETURNING_UPDATE")
    }
    if (node.ctes.some((c) => c.recursive)) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "WITH RECURSIVE in UPDATE (MySQL allows recursive CTEs only in SELECT)",
      )
    }
    if (node.from) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "UPDATE … FROM (use innerJoin/leftJoin instead — MySQL's multi-table UPDATE has no FROM clause)",
      )
    }
    if (node.joins.length === 0) return super.printUpdate(node)

    const parts: string[] = []
    if (node.ctes.length > 0) parts.push(this.printCTEs(node.ctes))

    parts.push("UPDATE", this.printTableRef(node.table))
    for (const join of node.joins) parts.push(this.printJoin(join))

    parts.push("SET")
    const sets = node.set.map(
      (s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`,
    )
    parts.push(sets.join(", "))

    if (node.where) parts.push("WHERE", this.printExpression(node.where))
    if (node.orderBy && node.orderBy.length > 0) {
      parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
    }
    if (node.limit) parts.push("LIMIT", this.printExpression(node.limit))

    return parts.join(" ")
  }

  protected override printFullTextSearch(node: FullTextSearchNode): string {
    const cols = node.columns.map((c) => this.printExpression(c)).join(", ")
    const query = this.printExpression(node.query)
    let mode = ""
    if (node.mode === "boolean") mode = " IN BOOLEAN MODE"
    else if (node.mode === "expansion") mode = " WITH QUERY EXPANSION"
    else if (node.mode === "natural") mode = " IN NATURAL LANGUAGE MODE"
    let result = `MATCH(${cols}) AGAINST(${query}${mode})`
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }

  /**
   * MySQL does not support the `GROUPS` window frame mode (it's a PG 11+
   * / SQLite 3.28+ feature). Refuse instead of emitting invalid SQL.
   * It also rejects the SQL:2011 `EXCLUDE` clause; the matrix entry
   * `FRAME_EXCLUDE` is the single source of truth for that guard.
   */
  protected override printFrameSpec(frame: FrameSpec): string {
    if (frame.kind === "GROUPS") {
      throw new UnsupportedDialectFeatureError("mysql", "GROUPS window frame (use ROWS or RANGE)")
    }
    if (frame.exclude !== undefined) {
      assertFeature("mysql", "FRAME_EXCLUDE")
    }
    return super.printFrameSpec(frame)
  }

  /** MySQL has no `ARRAY[...]` literal syntax. Use `JSON_ARRAY()` or raw SQL. */
  protected override printArrayExpr(_node: ArrayExprNode): string {
    throw new UnsupportedDialectFeatureError(
      "mysql",
      "ARRAY[...] literal (use JSON_ARRAY(...) or raw SQL for MySQL)",
    )
  }

  /**
   * MySQL 8 allows `ANY/ALL (SELECT ...)` but not `ANY/ALL (ARRAY[...])`
   * nor `ANY/ALL (?)` bound to an array param. The subquery form goes
   * through verbatim; any other operand is rejected here so the
   * error surfaces at compile time rather than as a mysql syntax
   * error at runtime.
   */
  protected override printQuantified(node: QuantifiedExprNode): string {
    if (node.operand.type !== "subquery") {
      assertFeature("mysql", "QUANTIFIED_ARRAY")
    }
    return super.printQuantified(node)
  }

  /** MySQL does not implement ANSI `MERGE`; use INSERT ... ON DUPLICATE KEY UPDATE. */
  protected override printMerge(_node: import("../ast/nodes.ts").MergeNode): string {
    throw new UnsupportedDialectFeatureError(
      "mysql",
      "MERGE INTO (use INSERT ... ON DUPLICATE KEY UPDATE on MySQL)",
    )
  }

  /**
   * MySQL uses `EXPLAIN [ANALYZE] [FORMAT=X] <stmt>` — no parens around
   * FORMAT, equals sign. Supported formats: TRADITIONAL, JSON, TREE.
   * PG's YAML/XML don't exist on MySQL; reject them. ANALYZE is 8.0.18+.
   */
  protected override printExplain(node: import("../ast/nodes.ts").ExplainNode): string {
    const parts: string[] = ["EXPLAIN"]
    if (node.analyze) parts.push("ANALYZE")
    if (node.format) {
      if (node.format === "YAML" || node.format === "XML") {
        throw new UnsupportedDialectFeatureError(
          "mysql",
          `EXPLAIN (FORMAT ${node.format}) — MySQL supports TRADITIONAL, JSON, TREE only`,
        )
      }
      // MySQL 8.0.18–8.0.31 disallow FORMAT with ANALYZE entirely;
      // 8.0.32+ allows FORMAT=TREE with ANALYZE but still not JSON /
      // TRADITIONAL. Refuse the non-TREE combos rather than silently
      // emit SQL the server rejects.
      if (node.analyze && node.format !== "TREE") {
        throw new UnsupportedDialectFeatureError(
          "mysql",
          `EXPLAIN ANALYZE FORMAT=${node.format} — MySQL only supports FORMAT=TREE with ANALYZE`,
        )
      }
      parts.push(`FORMAT=${node.format}`)
    }
    // Route through printNode on `this` so dialect-specific statement
    // printers (printSelect, printUpdate, etc.) apply to the nested SQL.
    parts.push(this.printNode(node.statement))
    return parts.join(" ")
  }

  /**
   * MySQL `->` / `->>` require the RHS to be a JSONPath starting with
   * `$` (e.g. `data->'$.name'`, `data->'$[0]'`). The base printer emits
   * PG's bare-key form (`data->'name'`), which MySQL rejects with
   * `ER_INVALID_JSON_PATH`. Rewrite the path literal here.
   *
   * Note on cross-dialect semantics: if a caller passes `at("a.b")` the
   * MySQL form becomes `$.a.b` — a two-level JSONPath. On PG the same
   * node emits `data->'a.b'` — a literal single key. Sumak treats
   * `.at(path)` as "the user-supplied JSON selector string"; dotted
   * keys are rare and chaining (`.at("a").at("b")`) is the
   * recommended portable form. Use `#>` with a segment array for
   * path traversal (PG only).
   *
   * `#>` / `#>>` path operators are PG-specific — reject with a pointer
   * at JSON_EXTRACT.
   */
  protected override printJsonAccess(node: import("../ast/nodes.ts").JsonAccessNode): string {
    if (node.operator === "#>" || node.operator === "#>>") {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        `${node.operator} JSON path operator — use JSON_EXTRACT(expr, '$.a.b') or chained '->' on MySQL`,
      )
    }
    // Rewrite single-segment path to JSONPath. `at("0")` → `$[0]`,
    // `at("name")` → `$.name`. Escape embedded quotes with the usual
    // single-quote doubling.
    const seg = /^\d+$/.test(node.path) ? `[${node.path}]` : `.${node.path}`
    const pathLiteral = `'$${escapeStringLiteral(seg)}'`
    const result = `${this.printExpression(node.expr)}${node.operator}${pathLiteral}`
    return node.alias ? `${result} AS ${quoteIdentifier(node.alias, this.dialect)}` : result
  }

  /** MySQL does not support `DELETE … RETURNING` — PG / SQLite 3.35+ only. */
  protected override printDelete(node: DeleteNode): string {
    if (node.returning.length > 0) {
      assertFeature("mysql", "RETURNING_DELETE")
    }
    if (node.ctes.some((c) => c.recursive)) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "WITH RECURSIVE in DELETE (MySQL allows recursive CTEs only in SELECT)",
      )
    }
    if (node.using) {
      // MySQL has no `DELETE FROM t USING other`; the multi-table
      // form is `DELETE t FROM t JOIN other ON …`. Point the caller
      // at `.innerJoin(...)` instead of silently emitting invalid SQL.
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "DELETE ... USING (use .innerJoin(other, on) — MySQL multi-table form is `DELETE t FROM t JOIN other`)",
      )
    }
    // MySQL multi-table DELETE: target alias/name precedes FROM.
    //   DELETE t FROM t INNER JOIN u ON ... WHERE ...
    // The base printer emits `DELETE FROM t INNER JOIN u ...` which
    // MySQL rejects at parse.
    if (node.joins.length > 0) {
      const parts: string[] = []
      if (node.ctes.length > 0) parts.push(this.printCTEs(node.ctes))
      const tableName = node.table.alias ?? node.table.name
      parts.push("DELETE", quoteIdentifier(tableName, this.dialect))
      parts.push("FROM", this.printTableRef(node.table))
      for (const join of node.joins) parts.push(this.printJoin(join))
      if (node.where) parts.push("WHERE", this.printExpression(node.where))
      if (node.orderBy && node.orderBy.length > 0) {
        parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
      }
      if (node.limit) parts.push("LIMIT", this.printExpression(node.limit))
      return parts.join(" ")
    }
    return super.printDelete(node)
  }

  /**
   * MySQL has no `FULL OUTER JOIN` — it requires `UNION` of LEFT + RIGHT
   * joins. Refuse rather than emit invalid SQL.
   */
  protected override printJoin(node: JoinNode): string {
    if (node.joinType === "FULL") {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "FULL JOIN (union a LEFT JOIN with a RIGHT JOIN instead)",
      )
    }
    return super.printJoin(node)
  }

  /**
   * MySQL has no `IS DISTINCT FROM` / `ILIKE` operators. Rewrite the
   * null-safe comparisons to `<=>` (or `NOT (a <=> b)`); reject `ILIKE`
   * — MySQL's default collations are typically case-insensitive so
   * plain `LIKE` is usually what the caller wanted.
   */
  protected override printBinaryOp(node: BinaryOpNode): string {
    if (node.op === "IS NOT DISTINCT FROM") {
      return `(${this.printExpression(node.left)} <=> ${this.printExpression(node.right)})`
    }
    if (node.op === "IS DISTINCT FROM") {
      return `(NOT (${this.printExpression(node.left)} <=> ${this.printExpression(node.right)}))`
    }
    if (node.op === "ILIKE" || node.op === "NOT ILIKE") {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        `${node.op} (MySQL's default collations are case-insensitive — use LIKE; for case-sensitive, use LIKE BINARY)`,
      )
    }
    return super.printBinaryOp(node)
  }

  /** MySQL does not support `NULLS FIRST / LAST` in ORDER BY. */
  protected override printOrderBy(node: OrderByNode): string {
    if (node.nulls) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "NULLS FIRST/LAST in ORDER BY (use ISNULL(col) as a secondary sort key)",
      )
    }
    return super.printOrderBy(node)
  }

  /**
   * MySQL does not support `<aggregate> FILTER (WHERE ...)` — it arrived
   * in SQL:2003 but only PG / SQLite 3.30+ / Firebird implement it.
   * Rewrite is possible with `CASE WHEN ... THEN value END` but it
   * changes semantics subtly for `COUNT` vs `COUNT(expr)`; refuse
   * instead and point the caller at the manual rewrite.
   *
   * Also refuses MySQL-absent SQL:2016 JSON functions. MySQL 8 has
   * `JSON_EXTRACT` (closest to `JSON_QUERY`) and `JSON_CONTAINS_PATH`
   * (closest to `JSON_EXISTS`, but takes a `'one'`/`'all'` flag), and
   * neither name parses as a function in MySQL. Refuse with a clear
   * error rather than emit SQL that fails at parse time.
   */
  protected override printFunctionCall(node: FunctionCallNode): string {
    if (node.filter) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "FILTER (WHERE ...) aggregate clause (rewrite as COUNT(CASE WHEN ... THEN 1 END) or SUM(CASE ...))",
      )
    }
    const upper = node.name.toUpperCase()
    if (upper === "JSON_QUERY") {
      assertFeature("mysql", "JSON_QUERY_FN")
    }
    if (upper === "JSON_EXISTS") {
      assertFeature("mysql", "JSON_EXISTS_FN")
    }
    // MySQL has no `DATE_TRUNC` or `AGE`. The truncation idiom is
    // `DATE_FORMAT(ts, '%Y-%m-01')` (or `MAKEDATE` for date-only
    // truncation); the interval-difference idiom is `TIMESTAMPDIFF`.
    // Refuse the standard names so the failure points at the builder
    // call, not a generic MySQL parse error.
    if (upper === "DATE_TRUNC") {
      assertFeature("mysql", "DATE_TRUNC_FN")
    }
    if (upper === "AGE") {
      assertFeature("mysql", "AGE_FN")
    }
    // MySQL has no `CORR`, `COVAR_*`, or `REGR_*` aggregates. They're
    // computable from `SUM`/`AVG`/`STDDEV` by hand, but the standard
    // names don't parse — refuse so the failure points at the builder.
    if (
      upper === "CORR" ||
      upper === "COVAR_POP" ||
      upper === "COVAR_SAMP" ||
      upper === "REGR_SLOPE" ||
      upper === "REGR_INTERCEPT" ||
      upper === "REGR_R2"
    ) {
      assertFeature("mysql", "LINEAR_REGRESSION_AGG")
    }
    // MySQL ships `REGEXP_REPLACE`, `REGEXP_LIKE`, `REGEXP_SUBSTR`
    // (8.0+) — let those pass through to the base printer. There is
    // no `REGEXP_MATCHES` analogue: MySQL's regex functions return
    // the matched substring, not the array of capture groups. Refuse
    // so the failure points at the builder.
    if (upper === "REGEXP_MATCHES") {
      assertFeature("mysql", "REGEXP_MATCHES_FN")
    }
    // MySQL's single-arg `LOG(x)` is **natural log**, not base-10;
    // base-10 lives under the `LOG10(x)` name. sumak's `log(x)`
    // builder is documented as base-10 across every dialect, so
    // rewrite the function name here. `LN(x)` exists natively on
    // MySQL and passes through unchanged.
    if (upper === "LOG" && node.args.length === 1) {
      return super.printFunctionCall({ ...node, name: "LOG10" })
    }
    return super.printFunctionCall(node)
  }

  /**
   * MySQL: `DATE_ADD(expr, INTERVAL N UNIT)` / `DATE_SUB(expr,
   * INTERVAL N UNIT)`. Unit keyword is uppercased and singular
   * (`DAY`, `MONTH`, …) per the MySQL grammar — `DAYS` would parse as
   * an identifier and `INTERVAL 7 DAYS` is a syntax error.
   *
   * Choice of `DATE_ADD` vs `DATE_SUB` is purely cosmetic — both
   * accept negative intervals — but emitting `DATE_SUB(expr, INTERVAL
   * 7 DAY)` for a negative amount reads more naturally than
   * `DATE_ADD(expr, INTERVAL -7 DAY)`. The result is byte-identical at
   * the planner level.
   */
  protected override printDateInterval(node: DateIntervalNode): string {
    const fn = node.amount < 0 ? "DATE_SUB" : "DATE_ADD"
    const magnitude = Math.abs(node.amount)
    const unitKeyword = node.unit.toUpperCase()
    const inner = `${fn}(${this.printExpression(node.expr)}, INTERVAL ${magnitude} ${unitKeyword})`
    return node.alias ? `${inner} AS ${quoteIdentifier(node.alias, this.dialect)}` : inner
  }
}
