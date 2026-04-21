import type {
  AliasedExprNode,
  ArrayExprNode,
  ASTNode,
  BetweenNode,
  BinaryOpNode,
  CaseNode,
  CastNode,
  ColumnRefNode,
  CTENode,
  DeleteNode,
  ExistsNode,
  ExplainNode,
  ExpressionNode,
  FrameBound,
  FrameSpec,
  FunctionCallNode,
  InNode,
  InsertNode,
  IsNullNode,
  JoinNode,
  JsonAccessNode,
  LiteralNode,
  OnConflictNode,
  OrderByNode,
  ParamNode,
  RawNode,
  SelectNode,
  StarNode,
  SubqueryNode,
  TableRefNode,
  TupleNode,
  UnaryOpNode,
  UpdateNode,
  WindowFunctionNode,
} from "../ast/nodes.ts"
import type {
  FullTextSearchNode,
  MergeNode,
  MergeWhenMatched,
  MergeWhenNotMatched,
} from "../ast/nodes.ts"
import type { CompiledQuery, SQLDialect } from "../types.ts"
import { quoteIdentifier, quoteTableRef } from "../utils/identifier.ts"
import { formatParam } from "../utils/param.ts"
import { escapeStringLiteral, validateDataType, validateFunctionName } from "../utils/security.ts"
import type { Printer } from "./types.ts"

/**
 * SQL:92 niladic functions — these are spelled as bare keywords, without
 * parentheses, on MSSQL. Other dialects accept either form but the
 * parens-free version is universally portable.
 */
/**
 * Functions that make sense only inside an `OVER (...)` window clause.
 * Emitting them as a bare call — `ROW_NUMBER()` without `OVER` — is a
 * runtime error on every dialect. We trap it at print time so the bug
 * surfaces in the typechecked build step instead of a driver error.
 */
const WINDOW_ONLY_FUNCTIONS: ReadonlySet<string> = new Set([
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "PERCENT_RANK",
  "CUME_DIST",
  "NTILE",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTH_VALUE",
])

const NILADIC_FUNCTIONS: ReadonlySet<string> = new Set([
  "CURRENT_TIMESTAMP",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_USER",
  "SESSION_USER",
  "SYSTEM_USER",
  "LOCALTIME",
  "LOCALTIMESTAMP",
])

/**
 * Standard SQL / ANSI built-in functions whose names are traditionally
 * emitted uppercase for portability. Anything NOT in this set is a
 * user-defined function or third-party extension and is emitted
 * verbatim — users can write `"mixedCaseUdf"` or `my_udf` and get back
 * the exact casing they passed, which matters for quoted identifiers
 * in PG / case-sensitive MySQL collations.
 */
const STANDARD_FUNCTIONS: ReadonlySet<string> = new Set([
  // Aggregates
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "STDDEV",
  "VARIANCE",
  "STRING_AGG",
  "GROUP_CONCAT",
  "ARRAY_AGG",
  "JSON_AGG",
  "JSONB_AGG",
  "JSON_OBJECT_AGG",
  // Window
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "PERCENT_RANK",
  "CUME_DIST",
  "NTILE",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTH_VALUE",
  // String
  "UPPER",
  "LOWER",
  "CONCAT",
  "SUBSTRING",
  "TRIM",
  "LTRIM",
  "RTRIM",
  "LENGTH",
  "CHAR_LENGTH",
  "REPLACE",
  "POSITION",
  // Numeric
  "ABS",
  "ROUND",
  "CEIL",
  "CEILING",
  "FLOOR",
  "POWER",
  "SQRT",
  "GREATEST",
  "LEAST",
  "MOD",
  // Conditional
  "COALESCE",
  "NULLIF",
  // Cast / conversion
  "CAST",
  "CONVERT",
  // JSON
  "JSON_BUILD_OBJECT",
  "JSONB_BUILD_OBJECT",
  "JSON_BUILD_ARRAY",
  "TO_JSON",
  "TO_JSONB",
  // Full-text
  "FREETEXT",
  "CONTAINS",
])

export class BasePrinter implements Printer {
  protected params: unknown[] = []
  protected dialect: SQLDialect
  /**
   * Tracks whether we're currently rendering the `fn` half of a
   * `window_function` node. Lets `printFunctionCall` throw when a
   * window-only function (ROW_NUMBER, LAG, …) is emitted outside an
   * OVER clause, but accept the same function inside one.
   */
  protected insideOver = false

  constructor(dialect: SQLDialect) {
    this.dialect = dialect
  }

  print(node: ASTNode): CompiledQuery {
    this.params = []
    const sql = this.printNode(node)
    return { sql, params: [...this.params] }
  }

  protected printNode(node: ASTNode): string {
    switch (node.type) {
      case "select":
        return this.printSelect(node)
      case "insert":
        return this.printInsert(node)
      case "update":
        return this.printUpdate(node)
      case "delete":
        return this.printDelete(node)
      case "merge":
        return this.printMerge(node)
      case "explain":
        return this.printExplain(node)
      default:
        return this.printExpression(node)
    }
  }

  protected printSelect(node: SelectNode): string {
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("SELECT")

    if (node.distinctOn && node.distinctOn.length > 0) {
      parts.push(`DISTINCT ON (${node.distinctOn.map((e) => this.printExpression(e)).join(", ")})`)
    } else if (node.distinct) {
      parts.push("DISTINCT")
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

    // SET OP ordering is tricky: in standard SQL, `ORDER BY / LIMIT / OFFSET`
    // on a `SELECT ... UNION SELECT` applies to the *combined* result and
    // must appear after the last SELECT, not between them. Emitting them
    // before the setOp produces a syntax error in PG/MySQL/SQLite.
    // Strategy: if a setOp is present, emit the right-hand SELECT first,
    // then the outer-query's ORDER BY/LIMIT/OFFSET.
    if (!node.setOp) {
      if (node.orderBy.length > 0) {
        parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
      }
      if (node.limit) {
        parts.push("LIMIT", this.printExpression(node.limit))
      }
      if (node.offset) {
        parts.push("OFFSET", this.printExpression(node.offset))
      }
    } else {
      // When the right-hand operand of a set-op carries its own
      // ORDER BY / LIMIT / OFFSET, the ANSI form requires the inner
      // SELECT to be wrapped in parens so the clauses bind to it and
      // not to the combined result. Without parens every engine
      // (pg / mysql / sqlite / mssql) either errors at parse time or
      // silently reassigns the clause to the outer query.
      const inner = node.setOp.query
      const innerHasPagination =
        inner.orderBy.length > 0 || inner.limit !== undefined || inner.offset !== undefined
      const printedInner = this.printSelect(inner)
      parts.push(node.setOp.op, innerHasPagination ? `(${printedInner})` : printedInner)
      if (node.orderBy.length > 0) {
        parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
      }
      if (node.limit) {
        parts.push("LIMIT", this.printExpression(node.limit))
      }
      if (node.offset) {
        parts.push("OFFSET", this.printExpression(node.offset))
      }
    }

    if (node.lock) {
      parts.push(`FOR ${node.lock.mode}`)
      if (node.lock.of && node.lock.of.length > 0) {
        parts.push("OF", node.lock.of.map((t) => quoteIdentifier(t, this.dialect)).join(", "))
      }
      if (node.lock.noWait) {
        parts.push("NOWAIT")
      } else if (node.lock.skipLocked) {
        parts.push("SKIP LOCKED")
      }
    }

    return parts.join(" ")
  }

  protected printInsert(node: InsertNode): string {
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    const insertKeyword = node.insertMode ?? "INSERT"
    parts.push(`${insertKeyword} INTO`, this.printTableRef(node.table))

    if (node.columns.length > 0) {
      parts.push(`(${node.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")})`)
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

    if (node.onConflict) {
      parts.push(this.printOnConflict(node.onConflict))
    }

    if (node.returning.length > 0) {
      parts.push("RETURNING", node.returning.map((r) => this.printExpression(r)).join(", "))
    }

    return parts.join(" ")
  }

  protected printOnConflict(node: OnConflictNode): string {
    const parts: string[] = ["ON CONFLICT"]

    if (node.constraint) {
      parts.push(`ON CONSTRAINT ${quoteIdentifier(node.constraint, this.dialect)}`)
    } else if (node.columns.length > 0) {
      parts.push(`(${node.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")})`)
    }

    if (node.action === "nothing") {
      parts.push("DO NOTHING")
    } else {
      parts.push("DO UPDATE SET")
      const sets = node.action.set.map(
        (s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`,
      )
      parts.push(sets.join(", "))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    return parts.join(" ")
  }

  protected printUpdate(node: UpdateNode): string {
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("UPDATE", this.printTableRef(node.table), "SET")

    const sets = node.set.map(
      (s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`,
    )
    parts.push(sets.join(", "))

    // PG `UPDATE ... FROM ... [JOIN ...] WHERE` requires FROM before JOINs.
    // MySQL's `UPDATE t JOIN ...` has no FROM. Emit FROM first when present,
    // then JOINs — the MySQL printer override handles its own form.
    if (node.from) {
      parts.push("FROM", this.printTableRef(node.from))
    }

    for (const join of node.joins) {
      parts.push(this.printJoin(join))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    if (node.orderBy && node.orderBy.length > 0) {
      parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
    }

    if (node.limit) {
      parts.push("LIMIT", this.printExpression(node.limit))
    }

    if (node.returning.length > 0) {
      parts.push("RETURNING", node.returning.map((r) => this.printExpression(r)).join(", "))
    }

    return parts.join(" ")
  }

  protected printDelete(node: DeleteNode): string {
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("DELETE FROM", this.printTableRef(node.table))

    if (node.using) {
      parts.push("USING", this.printTableRef(node.using))
    }

    for (const join of node.joins) {
      parts.push(this.printJoin(join))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    if (node.orderBy && node.orderBy.length > 0) {
      parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
    }

    if (node.limit) {
      parts.push("LIMIT", this.printExpression(node.limit))
    }

    if (node.returning.length > 0) {
      parts.push("RETURNING", node.returning.map((r) => this.printExpression(r)).join(", "))
    }

    return parts.join(" ")
  }

  protected printExpression(node: ExpressionNode): string {
    switch (node.type) {
      case "column_ref":
        return this.printColumnRef(node)
      case "literal":
        return this.printLiteral(node)
      case "binary_op":
        return this.printBinaryOp(node)
      case "unary_op":
        return this.printUnaryOp(node)
      case "function_call":
        return this.printFunctionCall(node)
      case "param":
        return this.printParam(node)
      case "raw":
        return this.printRaw(node)
      case "subquery":
        return this.printSubquery(node)
      case "between":
        return this.printBetween(node)
      case "in":
        return this.printIn(node)
      case "is_null":
        return this.printIsNull(node)
      case "cast":
        return this.printCast(node)
      case "exists":
        return this.printExists(node)
      case "star":
        return this.printStar(node)
      case "case":
        return this.printCase(node)
      case "json_access":
        return this.printJsonAccess(node)
      case "array_expr":
        return this.printArrayExpr(node)
      case "window_function":
        return this.printWindowFunction(node)
      case "aliased_expr":
        return this.printAliasedExpr(node)
      case "full_text_search":
        return this.printFullTextSearch(node)
      case "tuple":
        return this.printTuple(node)
    }
  }

  protected printColumnRef(node: ColumnRefNode): string {
    let result = node.table
      ? `${quoteIdentifier(node.table, this.dialect)}.${quoteIdentifier(node.column, this.dialect)}`
      : quoteIdentifier(node.column, this.dialect)

    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }

  protected printLiteral(node: LiteralNode): string {
    if (node.value === null) return "NULL"
    if (typeof node.value === "boolean") return node.value ? "TRUE" : "FALSE"
    if (typeof node.value === "number") return String(node.value)
    return `'${escapeStringLiteral(String(node.value))}'`
  }

  protected printBinaryOp(node: BinaryOpNode): string {
    return `(${this.printExpression(node.left)} ${node.op} ${this.printExpression(node.right)})`
  }

  protected printUnaryOp(node: UnaryOpNode): string {
    if (node.position === "postfix") {
      return `(${this.printExpression(node.operand)} ${node.op})`
    }
    return `(${node.op} ${this.printExpression(node.operand)})`
  }

  protected printFunctionCall(node: FunctionCallNode): string {
    validateFunctionName(node.name)
    // Window-only functions (ROW_NUMBER, LAG, …) are meaningless without
    // an OVER clause — every dialect rejects them at runtime. Trap the
    // missing OVER at print time with a message that points at `over()`.
    if (!this.insideOver && WINDOW_ONLY_FUNCTIONS.has(node.name.toUpperCase())) {
      throw new Error(
        `${node.name.toUpperCase()} is a window function — it must be used with \`over(${node.name.toLowerCase()}(), w => …)\`. ` +
          "Bare calls emit invalid SQL on every dialect.",
      )
    }
    // SQL:92 niladic functions are spelled as keywords (no parentheses).
    // `CURRENT_TIMESTAMP()` is invalid on MSSQL; the bare keyword is
    // portable across pg/mysql/sqlite/mssql.
    if (NILADIC_FUNCTIONS.has(node.name.toUpperCase()) && node.args.length === 0 && !node.filter) {
      let result = node.name.toUpperCase()
      if (node.alias) {
        result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
      }
      return result
    }
    const distinctPrefix = node.distinct ? "DISTINCT " : ""
    let inner = `${distinctPrefix}${node.args.map((a) => this.printExpression(a)).join(", ")}`
    if (node.orderBy && node.orderBy.length > 0) {
      inner += ` ORDER BY ${node.orderBy.map((o) => this.printOrderBy(o)).join(", ")}`
    }
    // Uppercase only standard SQL / ANSI built-ins for portability.
    // User-defined and extension functions keep their original casing
    // so quoted identifiers in PG / case-sensitive MySQL collations
    // resolve to the right function.
    const upper = node.name.toUpperCase()
    const emittedName = STANDARD_FUNCTIONS.has(upper) ? upper : node.name
    let result = `${emittedName}(${inner})`
    if (node.filter) {
      result += ` FILTER (WHERE ${this.printExpression(node.filter)})`
    }
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }

  protected printParam(node: ParamNode): string {
    this.params.push(this.coerceParamValue(node.value))
    return formatParam(this.params.length - 1, this.dialect)
  }

  /**
   * Convert special JS values into shapes the underlying drivers accept.
   *
   * - `bigint` → string. `node-postgres` / `postgres.js` / mysql2 all
   *   reject a bare `BigInt` because their serializer can't handle it;
   *   passing the decimal string form lets the driver treat it as a
   *   bigint parameter. This is the path drivers themselves recommend.
   *
   * Other types pass through unchanged. Extend here if new edge-case
   * conversions are needed (e.g. `Temporal.*`, `Buffer`, etc.).
   */
  protected coerceParamValue(value: unknown): unknown {
    if (typeof value === "bigint") return value.toString()
    return value
  }

  protected printRaw(node: RawNode): string {
    // `sql` tagged templates embed interpolated values using a null-byte
    // sentinel `\x00SUMAK_PARAM_N\x00` that users can't type in a string
    // literal. Printer substitutes them with dialect-correct placeholders,
    // using the current `this.params` length as the base offset so raw
    // params interleave correctly with surrounding param positions.
    const baseIndex = this.params.length
    this.params.push(...node.params)
    // NUL (U+0000) delimited sentinel — oxlint flags the \x00 escape in
    // regex as a control-char warning; the unicode escape form is
    // semantically identical and lint-clean.
    const SENTINEL_START = "\u0000SUMAK_PARAM_"
    if (node.sql.indexOf(SENTINEL_START) === -1) return node.sql
    // oxlint-disable-next-line no-control-regex — intentional sentinel
    return node.sql.replace(/\u0000SUMAK_PARAM_(\d+)\u0000/g, (_m, i) =>
      formatParam(baseIndex + Number(i), this.dialect),
    )
  }

  protected printSubquery(node: SubqueryNode): string {
    let result = `(${this.printSelect(node.query)})`
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }

  protected printBetween(node: BetweenNode): string {
    const neg = node.negated ? "NOT " : ""
    const sym = node.symmetric ? " SYMMETRIC" : ""
    return `(${this.printExpression(node.expr)} ${neg}BETWEEN${sym} ${this.printExpression(node.low)} AND ${this.printExpression(node.high)})`
  }

  protected printIn(node: InNode): string {
    const neg = node.negated ? "NOT " : ""
    if (Array.isArray(node.values)) {
      // `IN ()` is a syntax error in every dialect. Constant-fold empty
      // lists to the logically-equivalent boolean constant so SQL stays valid.
      // NOT IN (∅) is always TRUE; IN (∅) is always FALSE. MSSQL rejects
      // bare TRUE/FALSE in predicates, so use the portable `(1=0)` / `(1=1)`.
      if (node.values.length === 0) {
        if (this.dialect === "mssql") return node.negated ? "(1=1)" : "(1=0)"
        return node.negated ? "TRUE" : "FALSE"
      }
      return `(${this.printExpression(node.expr)} ${neg}IN (${node.values.map((v) => this.printExpression(v)).join(", ")}))`
    }
    return `(${this.printExpression(node.expr)} ${neg}IN (${this.printSelect(node.values)}))`
  }

  protected printIsNull(node: IsNullNode): string {
    const neg = node.negated ? " NOT" : ""
    return `(${this.printExpression(node.expr)} IS${neg} NULL)`
  }

  protected printCase(node: CaseNode): string {
    const parts: string[] = ["CASE"]
    if (node.operand) {
      parts.push(this.printExpression(node.operand))
    }
    for (const when of node.whens) {
      parts.push(
        "WHEN",
        this.printExpression(when.condition),
        "THEN",
        this.printExpression(when.result),
      )
    }
    if (node.else_) {
      parts.push("ELSE", this.printExpression(node.else_))
    }
    parts.push("END")
    return parts.join(" ")
  }

  protected printCast(node: CastNode): string {
    validateDataType(node.dataType)
    return `CAST(${this.printExpression(node.expr)} AS ${node.dataType})`
  }

  protected printExists(node: ExistsNode): string {
    const neg = node.negated ? "NOT " : ""
    return `(${neg}EXISTS (${this.printSelect(node.query)}))`
  }

  protected printStar(node: StarNode): string {
    return node.table ? `${quoteIdentifier(node.table, this.dialect)}.*` : "*"
  }

  protected printTableRef(ref: TableRefNode): string {
    let result = quoteTableRef(ref.name, this.dialect, ref.schema)
    if (ref.temporal) {
      result += ` ${this.printTemporalClause(ref.temporal)}`
    }
    if (ref.alias) {
      result += ` AS ${quoteIdentifier(ref.alias, this.dialect)}`
    }
    return result
  }

  /**
   * Print a GRAPH_TABLE clause — SQL:2023 Part 16 (SQL/PGQ).
   *
   * Default emits the standard `GRAPH_TABLE(graph MATCH ... COLUMNS ...)`
   * form. Dialects with non-standard graph extensions (e.g. Apache AGE's
   * `cypher('graph', $$...$$) AS g(col agtype)`) override this method.
   */
  protected printGraphTable(node: import("../ast/graph-nodes.ts").GraphTableNode): string {
    const pattern = this._inlineGraphPattern(node.match)
    const cols = node.columns
      .map((c) => (c.alias ? `${c.expr} AS ${quoteIdentifier(c.alias, this.dialect)}` : c.expr))
      .join(", ")
    const parts = [`GRAPH_TABLE (${quoteIdentifier(node.graph, this.dialect)}`, `MATCH ${pattern}`]
    if (node.where) parts.push(`WHERE ${this.printExpression(node.where)}`)
    parts.push(`COLUMNS (${cols}))`)
    let result = parts.join(" ")
    if (node.alias) result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    return result
  }

  /**
   * Substitute `GRAPH_PARAM_TOKEN` placeholders in a pattern string with
   * parameter references collected through the normal params pipeline.
   */
  protected _inlineGraphPattern(pattern: import("../ast/graph-nodes.ts").GraphPatternNode): string {
    const token = "\x00SUMAK_GRAPH_PARAM\x00"
    const pieces = pattern.pattern.split(token)
    // Defensive: if the user's literal pattern text contained the
    // internal sentinel, the split produces too many pieces and we'd
    // misalign params silently. Very unlikely (null bytes around a
    // reserved identifier) but the failure mode is data corruption.
    if (pieces.length !== pattern.paramValues.length + 1) {
      throw new Error(
        "GraphPatternNode: pattern text contains the internal SUMAK_GRAPH_PARAM sentinel — " +
          "cannot safely substitute parameters. Please report this at the sumak issue tracker.",
      )
    }
    let result = pieces[0] ?? ""
    for (let i = 0; i < pattern.paramValues.length; i++) {
      this.params.push(pattern.paramValues[i])
      result += formatParam(this.params.length - 1, this.dialect) + (pieces[i + 1] ?? "")
    }
    return result
  }

  protected printTemporalClause(clause: import("../ast/nodes.ts").TemporalClause): string {
    switch (clause.kind) {
      case "as_of":
        return `FOR SYSTEM_TIME AS OF ${this.printExpression(clause.timestamp)}`
      case "from_to":
        return `FOR SYSTEM_TIME FROM ${this.printExpression(clause.start)} TO ${this.printExpression(clause.end)}`
      case "between":
        return `FOR SYSTEM_TIME BETWEEN ${this.printExpression(clause.start)} AND ${this.printExpression(clause.end)}`
      case "contained_in":
        return `FOR SYSTEM_TIME CONTAINED IN (${this.printExpression(clause.start)}, ${this.printExpression(clause.end)})`
      case "all":
        return "FOR SYSTEM_TIME ALL"
    }
  }

  protected printJoin(node: JoinNode): string {
    if (!node.on && node.joinType !== "CROSS") {
      // Without ON the join silently degrades to a cross product —
      // usually not what the user wanted. `CROSS JOIN` must be
      // requested explicitly.
      throw new Error(
        `${node.joinType} JOIN requires an ON condition. ` +
          "Use .innerJoin(t, on) / .leftJoin(t, on) / …, or .crossJoin(t) for an unconditional cross product.",
      )
    }
    const parts: string[] = []
    const lateral = node.lateral ? " LATERAL" : ""
    parts.push(`${node.joinType} JOIN${lateral}`)

    if (node.table.type === "subquery") {
      parts.push(this.printSubquery(node.table))
    } else {
      parts.push(this.printTableRef(node.table))
    }

    if (node.on) {
      parts.push("ON", this.printExpression(node.on))
    }

    return parts.join(" ")
  }

  protected printOrderBy(node: OrderByNode): string {
    let result = `${this.printExpression(node.expr)} ${node.direction}`
    if (node.nulls) {
      result += ` NULLS ${node.nulls}`
    }
    return result
  }

  protected printCTEs(ctes: CTENode[]): string {
    const hasRecursive = ctes.some((c) => c.recursive)
    const prefix = hasRecursive ? "WITH RECURSIVE" : "WITH"
    const cteParts = ctes.map(
      (c) => `${quoteIdentifier(c.name, this.dialect)} AS (${this.printSelect(c.query)})`,
    )
    return `${prefix} ${cteParts.join(", ")}`
  }

  protected printJsonAccess(node: JsonAccessNode): string {
    // PG path operators `#>` / `#>>` expect the path as a text-array literal
    // (`'{a,b,c}'`), not a dotted string. `->` / `->>` accept a single key
    // (string literal) OR an integer index (bare number — no quotes).
    // `jsonCol("data").at("0")` stores "0" as the path — decimal-only
    // strings render as bare integers so array navigation works. Users
    // who really want an object key named "0" can use `at('"0"')` …
    // rare edge, documented.
    const isPath = node.operator === "#>" || node.operator === "#>>"
    const pathLiteral = isPath
      ? `'{${pgJsonPathSegments(node.path).join(",")}}'`
      : /^\d+$/.test(node.path)
        ? node.path // bare integer → array index
        : this.printLiteral({ type: "literal", value: node.path })
    let result = `${this.printExpression(node.expr)}${node.operator}${pathLiteral}`
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }

  protected printArrayExpr(node: ArrayExprNode): string {
    return `ARRAY[${node.elements.map((e) => this.printExpression(e)).join(", ")}]`
  }

  protected printWindowFunction(node: WindowFunctionNode): string {
    const parts: string[] = []
    // Signal to `printFunctionCall` that we're legitimately emitting a
    // window-only function; otherwise the WINDOW_ONLY_FUNCTIONS guard
    // would fire on every ROW_NUMBER / LAG / LEAD / etc.
    const prev = this.insideOver
    this.insideOver = true
    try {
      parts.push(this.printFunctionCall(node.fn))
    } finally {
      this.insideOver = prev
    }
    parts.push("OVER")

    const overParts: string[] = []
    if (node.partitionBy.length > 0) {
      overParts.push(
        `PARTITION BY ${node.partitionBy.map((p) => this.printExpression(p)).join(", ")}`,
      )
    }
    if (node.orderBy.length > 0) {
      overParts.push(`ORDER BY ${node.orderBy.map((o) => this.printOrderBy(o)).join(", ")}`)
    }
    if (node.frame) {
      overParts.push(this.printFrameSpec(node.frame))
    }

    parts.push(`(${overParts.join(" ")})`)

    if (node.alias) {
      parts.push("AS", quoteIdentifier(node.alias, this.dialect))
    }
    return parts.join(" ")
  }

  protected printFrameSpec(frame: FrameSpec): string {
    const start = this.printFrameBound(frame.start)
    if (frame.end) {
      return `${frame.kind} BETWEEN ${start} AND ${this.printFrameBound(frame.end)}`
    }
    return `${frame.kind} ${start}`
  }

  protected printFrameBound(bound: FrameBound): string {
    switch (bound.type) {
      case "unbounded_preceding":
        return "UNBOUNDED PRECEDING"
      case "preceding":
        return `${bound.value} PRECEDING`
      case "current_row":
        return "CURRENT ROW"
      case "following":
        return `${bound.value} FOLLOWING`
      case "unbounded_following":
        return "UNBOUNDED FOLLOWING"
    }
  }

  protected printMerge(node: MergeNode): string {
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("MERGE INTO", this.printTableRef(node.target))
    parts.push("USING")

    if (node.source.type === "subquery") {
      // MERGE carries its own `sourceAlias`; emitting the subquery's
      // inner alias too produces invalid `... AS "s" AS "s"`. Print
      // the subquery body without its alias, then append the
      // canonical `AS <sourceAlias>`.
      parts.push(this.printSubquery({ ...node.source, alias: undefined }))
    } else {
      parts.push(this.printTableRef(node.source))
    }

    parts.push("AS", quoteIdentifier(node.sourceAlias, this.dialect))
    parts.push("ON", this.printExpression(node.on))

    for (const when of node.whens) {
      if (when.type === "matched") {
        parts.push(this.printMergeWhenMatched(when))
      } else {
        parts.push(this.printMergeWhenNotMatched(when))
      }
    }

    return parts.join(" ")
  }

  protected printMergeWhenMatched(when: MergeWhenMatched): string {
    const parts: string[] = ["WHEN MATCHED"]
    if (when.condition) {
      parts.push("AND", this.printExpression(when.condition))
    }
    if (when.action === "delete") {
      parts.push("THEN DELETE")
    } else {
      parts.push("THEN UPDATE SET")
      const sets = (when.set ?? []).map(
        (s) => `${quoteIdentifier(s.column, this.dialect)} = ${this.printExpression(s.value)}`,
      )
      parts.push(sets.join(", "))
    }
    return parts.join(" ")
  }

  protected printMergeWhenNotMatched(when: MergeWhenNotMatched): string {
    const parts: string[] = ["WHEN NOT MATCHED"]
    if (when.condition) {
      parts.push("AND", this.printExpression(when.condition))
    }
    parts.push("THEN INSERT")
    parts.push(`(${when.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")})`)
    parts.push(`VALUES (${when.values.map((v) => this.printExpression(v)).join(", ")})`)
    return parts.join(" ")
  }

  protected printAliasedExpr(node: AliasedExprNode): string {
    return `${this.printExpression(node.expr)} AS ${quoteIdentifier(node.alias, this.dialect)}`
  }

  protected printTuple(node: TupleNode): string {
    return `(${node.elements.map((e) => this.printExpression(e)).join(", ")})`
  }

  protected printExplain(node: ExplainNode): string {
    const parts: string[] = ["EXPLAIN"]
    if (node.analyze) {
      parts.push("ANALYZE")
    }
    if (node.format) {
      parts.push(`(FORMAT ${node.format})`)
    }
    parts.push(this.printNode(node.statement))
    return parts.join(" ")
  }

  protected printFullTextSearch(node: FullTextSearchNode): string {
    // Default: PostgreSQL style — to_tsvector(cols) @@ to_tsquery(query)
    const cols = node.columns.map((c) => this.printExpression(c)).join(" || ' ' || ")
    // `language` is emitted as a SQL string literal. Escape to prevent
    // breakout: without `escapeStringLiteral` any `'` in the config
    // name (or deliberately crafted input) terminates the literal.
    const lang = node.language ? `'${escapeStringLiteral(node.language)}', ` : ""
    let result = `(to_tsvector(${lang}${cols}) @@ to_tsquery(${lang}${this.printExpression(node.query)}))`
    if (node.alias) {
      result += ` AS ${quoteIdentifier(node.alias, this.dialect)}`
    }
    return result
  }
}

/**
 * Split a dotted JSON-path string (`"a.b.c"` or `"a.0.c"` with numeric
 * indices) into segments for a PG text-array literal `{a,b,c}`. Rejects
 * segments containing characters that would break the array literal
 * (single quote, comma, brace) so `atPath` can't become an injection
 * vector for attacker-controlled path strings.
 */
function pgJsonPathSegments(path: string): string[] {
  const parts = path.split(".")
  for (const p of parts) {
    // Reject anything that could break the array-literal context:
    //   quotes/comma/brace — direct syntax,
    //   backslash — PG treats `\c` as an escape inside an array string,
    //   newline/CR — upper-layer loggers and SQL sanitizers are often
    //   line-oriented; don't let a path smuggle one through.
    if (p.length === 0 || /["',{}\\\n\r]/.test(p)) {
      throw new Error(
        `Invalid JSON path segment ${JSON.stringify(p)} — segments must be non-empty ` +
          "and must not contain quote, comma, brace, backslash, or newline characters.",
      )
    }
  }
  return parts
}
