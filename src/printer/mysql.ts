import type {
  BinaryOpNode,
  DeleteNode,
  FrameSpec,
  FullTextSearchNode,
  FunctionCallNode,
  InsertNode,
  JoinNode,
  OrderByNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import { quoteIdentifier } from "../utils/identifier.ts"
import { BasePrinter } from "./base.ts"

export class MysqlPrinter extends BasePrinter {
  constructor() {
    super("mysql")
  }

  protected override printInsert(node: InsertNode): string {
    if (node.returning.length > 0) {
      throw new UnsupportedDialectFeatureError("mysql", "RETURNING")
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
      throw new UnsupportedDialectFeatureError("mysql", "DISTINCT ON")
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
      throw new UnsupportedDialectFeatureError("mysql", "RETURNING on UPDATE")
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
   */
  protected override printFrameSpec(frame: FrameSpec): string {
    if (frame.kind === "GROUPS") {
      throw new UnsupportedDialectFeatureError("mysql", "GROUPS window frame (use ROWS or RANGE)")
    }
    return super.printFrameSpec(frame)
  }

  /** MySQL does not support `DELETE … RETURNING` — PG / SQLite 3.35+ only. */
  protected override printDelete(node: DeleteNode): string {
    if (node.returning.length > 0) {
      throw new UnsupportedDialectFeatureError("mysql", "RETURNING on DELETE")
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
   */
  protected override printFunctionCall(node: FunctionCallNode): string {
    if (node.filter) {
      throw new UnsupportedDialectFeatureError(
        "mysql",
        "FILTER (WHERE ...) aggregate clause (rewrite as COUNT(CASE WHEN ... THEN 1 END) or SUM(CASE ...))",
      )
    }
    return super.printFunctionCall(node)
  }
}
