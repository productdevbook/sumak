import type {
  DeleteNode,
  FullTextSearchNode,
  InsertNode,
  SelectNode,
  UpdateNode,
} from "../ast/nodes.ts"
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
      throw new UnsupportedDialectFeatureError("mssql", "DISTINCT ON")
    }

    parts.push("SELECT")

    if (node.distinct) {
      parts.push("DISTINCT")
    }

    // MSSQL: TOP N instead of LIMIT (only when no OFFSET)
    if (node.limit && !node.offset) {
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

    if (node.orderBy.length > 0) {
      parts.push("ORDER BY", node.orderBy.map((o) => this.printOrderBy(o)).join(", "))
    }

    // MSSQL: OFFSET/FETCH instead of LIMIT/OFFSET (requires ORDER BY)
    if (node.offset) {
      parts.push(`OFFSET ${this.printExpression(node.offset)} ROWS`)
      if (node.limit) {
        parts.push(`FETCH NEXT ${this.printExpression(node.limit)} ROWS ONLY`)
      }
    }

    if (node.setOp) {
      parts.push(node.setOp.op, this.printSelect(node.setOp.query))
    }

    if (node.lock) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "FOR UPDATE/SHARE (use WITH (UPDLOCK) hints instead)",
      )
    }

    return parts.join(" ")
  }

  protected override printInsert(node: InsertNode): string {
    if (node.onConflict) {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "ON CONFLICT (use MERGE for upsert in MSSQL)",
      )
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
      const cols = node.returning.map((r) => {
        const printed = this.printExpression(r)
        if (printed === "*") return "INSERTED.*"
        return `INSERTED.${printed}`
      })
      parts.push("OUTPUT", cols.join(", "))
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
      const cols = node.returning.map((r) => {
        const printed = this.printExpression(r)
        if (printed === "*") return "INSERTED.*"
        return `INSERTED.${printed}`
      })
      parts.push("OUTPUT", cols.join(", "))
    }

    if (node.from) {
      parts.push("FROM", this.printTableRef(node.from))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    return parts.join(" ")
  }

  protected override printDelete(node: DeleteNode): string {
    const parts: string[] = []

    if (node.ctes.length > 0) {
      parts.push(this.printCTEs(node.ctes))
    }

    parts.push("DELETE FROM", this.printTableRef(node.table))

    // MSSQL: OUTPUT instead of RETURNING
    if (node.returning.length > 0) {
      const cols = node.returning.map((r) => {
        const printed = this.printExpression(r)
        if (printed === "*") return "DELETED.*"
        return `DELETED.${printed}`
      })
      parts.push("OUTPUT", cols.join(", "))
    }

    if (node.where) {
      parts.push("WHERE", this.printExpression(node.where))
    }

    return parts.join(" ")
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
}
