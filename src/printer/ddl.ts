import type {
  AlterTableNode,
  ColumnDefinitionNode,
  CreateIndexNode,
  CreateSchemaNode,
  CreateTableNode,
  CreateViewNode,
  DDLNode,
  DropIndexNode,
  DropSchemaNode,
  DropTableNode,
  DropViewNode,
  ForeignKeyConstraintNode,
  TableConstraintNode,
  TruncateTableNode,
} from "../ast/ddl-nodes.ts"
import type { SelectNode } from "../ast/nodes.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import type { CompiledQuery, SQLDialect } from "../types.ts"
import { quoteIdentifier, quoteTableRef } from "../utils/identifier.ts"
import { escapeStringLiteral, validateFunctionName } from "../utils/security.ts"

/**
 * Optional callback used by CREATE TABLE ... AS SELECT and CREATE VIEW ... AS
 * to render the embedded SELECT using the dialect's BasePrinter. Without it
 * the SELECT body falls back to a placeholder; callers using DDLPrinter
 * through `db.generateDDL()` will always have it wired up.
 */
export type SelectPrinter = (node: SelectNode) => CompiledQuery

export class DDLPrinter {
  private dialect: SQLDialect
  private params: unknown[] = []
  private selectPrinter?: SelectPrinter

  constructor(dialect: SQLDialect, selectPrinter?: SelectPrinter) {
    this.dialect = dialect
    this.selectPrinter = selectPrinter
  }

  print(node: DDLNode): CompiledQuery {
    this.params = []
    const sql = this.printNode(node)
    return { sql, params: [...this.params] }
  }

  private printNode(node: DDLNode): string {
    switch (node.type) {
      case "create_table":
        return this.printCreateTable(node)
      case "alter_table":
        return this.printAlterTable(node)
      case "drop_table":
        return this.printDropTable(node)
      case "create_index":
        return this.printCreateIndex(node)
      case "drop_index":
        return this.printDropIndex(node)
      case "create_view":
        return this.printCreateView(node)
      case "drop_view":
        return this.printDropView(node)
      case "truncate_table":
        return this.printTruncateTable(node)
      case "create_schema":
        return this.printCreateSchema(node)
      case "drop_schema":
        return this.printDropSchema(node)
    }
  }

  private printCreateSchema(node: CreateSchemaNode): string {
    const parts = ["CREATE SCHEMA"]
    if (node.ifNotExists) parts.push("IF NOT EXISTS")
    parts.push(quoteIdentifier(node.name, this.dialect))
    if (node.authorization) {
      parts.push("AUTHORIZATION", quoteIdentifier(node.authorization, this.dialect))
    }
    return parts.join(" ")
  }

  private printDropSchema(node: DropSchemaNode): string {
    const parts = ["DROP SCHEMA"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(quoteIdentifier(node.name, this.dialect))
    if (node.cascade) parts.push("CASCADE")
    return parts.join(" ")
  }

  private printCreateTable(node: CreateTableNode): string {
    const parts: string[] = ["CREATE"]
    if (node.temporary) parts.push("TEMPORARY")
    parts.push("TABLE")
    if (node.ifNotExists) parts.push("IF NOT EXISTS")
    parts.push(quoteTableRef(node.table.name, this.dialect, node.table.schema))

    if (node.asSelect) {
      parts.push("AS")
      parts.push(`(${this.renderSelect(node.asSelect)})`)
      return parts.join(" ")
    }

    const defs: string[] = []
    for (const col of node.columns) {
      defs.push(this.printColumnDef(col))
    }
    for (const constraint of node.constraints) {
      defs.push(this.printConstraint(constraint))
    }
    parts.push(`(${defs.join(", ")})`)
    return parts.join(" ")
  }

  private printColumnDef(col: ColumnDefinitionNode): string {
    const parts: string[] = [quoteIdentifier(col.name, this.dialect), col.dataType]
    if (col.primaryKey) parts.push("PRIMARY KEY")
    if (col.autoIncrement) {
      if (this.dialect === "mysql") parts.push("AUTO_INCREMENT")
      // PG uses SERIAL type, SQLite uses AUTOINCREMENT
    }
    if (col.notNull) parts.push("NOT NULL")
    if (col.unique) parts.push("UNIQUE")
    if (col.defaultTo) parts.push("DEFAULT", this.printExpr(col.defaultTo))
    if (col.check) parts.push("CHECK", `(${this.printExpr(col.check)})`)
    if (col.references) {
      parts.push(
        "REFERENCES",
        `${quoteIdentifier(col.references.table, this.dialect)}(${quoteIdentifier(col.references.column, this.dialect)})`,
      )
      if (col.references.onDelete) parts.push("ON DELETE", col.references.onDelete)
      if (col.references.onUpdate) parts.push("ON UPDATE", col.references.onUpdate)
    }
    if (col.generatedAs) {
      parts.push("GENERATED ALWAYS AS", `(${this.printExpr(col.generatedAs.expression)})`)
      if (col.generatedAs.stored) parts.push("STORED")
    }
    return parts.join(" ")
  }

  private printConstraint(c: TableConstraintNode): string {
    const namePrefix = c.name ? `CONSTRAINT ${quoteIdentifier(c.name, this.dialect)} ` : ""
    switch (c.type) {
      case "pk_constraint":
        return `${namePrefix}PRIMARY KEY (${c.columns.map((col) => quoteIdentifier(col, this.dialect)).join(", ")})`
      case "unique_constraint":
        return `${namePrefix}UNIQUE (${c.columns.map((col) => quoteIdentifier(col, this.dialect)).join(", ")})`
      case "check_constraint":
        return `${namePrefix}CHECK (${this.printExpr(c.expression)})`
      case "fk_constraint":
        return this.printForeignKeyConstraint(c, namePrefix)
    }
  }

  private printForeignKeyConstraint(c: ForeignKeyConstraintNode, namePrefix: string): string {
    const cols = c.columns.map((col) => quoteIdentifier(col, this.dialect)).join(", ")
    const refCols = c.references.columns.map((col) => quoteIdentifier(col, this.dialect)).join(", ")
    let result = `${namePrefix}FOREIGN KEY (${cols}) REFERENCES ${quoteIdentifier(c.references.table, this.dialect)} (${refCols})`
    if (c.references.onDelete) result += ` ON DELETE ${c.references.onDelete}`
    if (c.references.onUpdate) result += ` ON UPDATE ${c.references.onUpdate}`
    return result
  }

  private printAlterTable(node: AlterTableNode): string {
    const tableName = quoteTableRef(node.table.name, this.dialect, node.table.schema)
    const results: string[] = []

    for (const action of node.actions) {
      const parts: string[] = ["ALTER TABLE", tableName]
      switch (action.kind) {
        case "add_column":
          parts.push("ADD COLUMN", this.printColumnDef(action.column))
          break
        case "drop_column":
          parts.push("DROP COLUMN", quoteIdentifier(action.column, this.dialect))
          break
        case "rename_column":
          parts.push(
            "RENAME COLUMN",
            quoteIdentifier(action.from, this.dialect),
            "TO",
            quoteIdentifier(action.to, this.dialect),
          )
          break
        case "rename_table":
          parts.push("RENAME TO", quoteIdentifier(action.to, this.dialect))
          break
        case "alter_column":
          parts.push("ALTER COLUMN", quoteIdentifier(action.column, this.dialect))
          switch (action.set.type) {
            case "set_not_null":
              parts.push("SET NOT NULL")
              break
            case "drop_not_null":
              parts.push("DROP NOT NULL")
              break
            case "set_default":
              parts.push("SET DEFAULT", this.printExpr(action.set.value))
              break
            case "drop_default":
              parts.push("DROP DEFAULT")
              break
            case "set_data_type":
              parts.push("SET DATA TYPE", action.set.dataType)
              break
          }
          break
        case "add_constraint":
          parts.push("ADD", this.printConstraint(action.constraint))
          break
        case "drop_constraint":
          parts.push("DROP CONSTRAINT", quoteIdentifier(action.name, this.dialect))
          break
      }
      results.push(parts.join(" "))
    }
    return results.join("; ")
  }

  private printDropTable(node: DropTableNode): string {
    const parts: string[] = ["DROP TABLE"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(quoteTableRef(node.table.name, this.dialect, node.table.schema))
    if (node.cascade) {
      if (this.dialect === "sqlite" || this.dialect === "mssql") {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "DROP TABLE ... CASCADE (drop dependent objects manually)",
        )
      }
      parts.push("CASCADE")
    }
    return parts.join(" ")
  }

  private printCreateIndex(node: CreateIndexNode): string {
    const parts: string[] = ["CREATE"]
    if (node.unique) parts.push("UNIQUE")
    parts.push("INDEX")
    if (node.ifNotExists) parts.push("IF NOT EXISTS")
    parts.push(quoteIdentifier(node.name, this.dialect))
    parts.push("ON", quoteIdentifier(node.table, this.dialect))

    if (node.using) {
      // `USING <method>` is emitted verbatim; reject anything that
      // isn't a bare identifier to stop attacker-controlled input from
      // slipping in extra statements.
      validateFunctionName(node.using)
      parts.push("USING", node.using)
    }

    if (node.columns.length > 0) {
      const cols = node.columns.map((c) => {
        let s = quoteIdentifier(c.column, this.dialect)
        if (c.direction) s += ` ${c.direction}`
        return s
      })
      parts.push(`(${cols.join(", ")})`)
    }

    if (node.where) {
      // Partial indexes: PG native, SQLite 3.8+, MSSQL (filtered indexes,
      // similar semantics). MySQL has no partial/filtered index at all
      // — refuse instead of emitting `WHERE ...` which MySQL rejects.
      if (this.dialect === "mysql") {
        throw new UnsupportedDialectFeatureError(
          "mysql",
          "Partial / filtered indexes (MySQL has no WHERE clause for CREATE INDEX)",
        )
      }
      parts.push("WHERE", this.printExpr(node.where))
    }
    return parts.join(" ")
  }

  private printDropIndex(node: DropIndexNode): string {
    const parts: string[] = ["DROP INDEX"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(quoteIdentifier(node.name, this.dialect))
    if (node.table) parts.push("ON", quoteIdentifier(node.table, this.dialect))
    if (node.cascade) {
      // `DROP INDEX ... CASCADE` is PG-only. SQLite allows no cascade;
      // MySQL / MSSQL both reject it at parse time.
      if (this.dialect !== "pg") {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "DROP INDEX ... CASCADE (PG-only; drop dependent objects manually)",
        )
      }
      parts.push("CASCADE")
    }
    return parts.join(" ")
  }

  private printCreateView(node: CreateViewNode): string {
    const parts: string[] = ["CREATE"]
    if (node.orReplace) parts.push("OR REPLACE")
    if (node.temporary) parts.push("TEMPORARY")
    if (node.materialized) parts.push("MATERIALIZED")
    parts.push("VIEW")
    if (node.ifNotExists) parts.push("IF NOT EXISTS")

    const viewName = node.schema
      ? `${quoteIdentifier(node.schema, this.dialect)}.${quoteIdentifier(node.name, this.dialect)}`
      : quoteIdentifier(node.name, this.dialect)
    parts.push(viewName)

    if (node.columns && node.columns.length > 0) {
      parts.push(`(${node.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")})`)
    }

    if (!node.asSelect) {
      throw new Error(
        `CREATE VIEW "${node.name}" requires an AS SELECT clause. ` +
          "Call .asSelect(query) on the view builder before compiling.",
      )
    }
    parts.push("AS")
    parts.push(this.renderSelect(node.asSelect))
    return parts.join(" ")
  }

  /**
   * Render a SELECT using the injected callback, merging its params into the
   * DDL output. Throws if no callback was wired up — the bare string stub was
   * a silent data-corruption bug.
   */
  private renderSelect(node: SelectNode): string {
    if (!this.selectPrinter) {
      throw new Error(
        "DDLPrinter: CREATE TABLE ... AS SELECT / CREATE VIEW AS requires a SELECT printer. " +
          "Use db.compileDDL()/db.generateDDL() so the dialect's printer is wired up.",
      )
    }
    const rendered = this.selectPrinter(node)
    this.params.push(...rendered.params)
    return rendered.sql
  }

  private printDropView(node: DropViewNode): string {
    const parts: string[] = ["DROP"]
    if (node.materialized) parts.push("MATERIALIZED")
    parts.push("VIEW")
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(quoteIdentifier(node.name, this.dialect))
    if (node.cascade) {
      // `DROP VIEW ... CASCADE` is PG-only. SQLite allows no cascade;
      // MySQL / MSSQL reject the keyword entirely.
      if (this.dialect !== "pg") {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "DROP VIEW ... CASCADE (PG-only; drop dependent objects manually)",
        )
      }
      parts.push("CASCADE")
    }
    return parts.join(" ")
  }

  private printTruncateTable(node: TruncateTableNode): string {
    if (this.dialect === "sqlite") {
      // SQLite has no TRUNCATE TABLE — use DELETE FROM. Some tooling
      // auto-rewrites, but semantics differ (TRUNCATE is DDL, ignores
      // triggers, etc.), so refuse rather than silently change behavior.
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        "TRUNCATE TABLE (SQLite has no TRUNCATE — use `db.deleteFrom(t).allRows()`)",
      )
    }
    const parts: string[] = ["TRUNCATE TABLE"]
    parts.push(quoteTableRef(node.table.name, this.dialect, node.table.schema))
    if (node.restartIdentity) {
      if (this.dialect === "mssql" || this.dialect === "mysql") {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "TRUNCATE ... RESTART IDENTITY (use DBCC CHECKIDENT on MSSQL, ALTER TABLE AUTO_INCREMENT on MySQL)",
        )
      }
      parts.push("RESTART IDENTITY")
    }
    if (node.cascade) {
      if (this.dialect === "mssql" || this.dialect === "mysql") {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "TRUNCATE ... CASCADE (truncate dependent tables manually)",
        )
      }
      parts.push("CASCADE")
    }
    return parts.join(" ")
  }

  private printExpr(node: import("../ast/nodes.ts").ExpressionNode): string {
    // Simplified expression printing for DDL contexts
    switch (node.type) {
      case "literal":
        if (node.value === null) return "NULL"
        if (typeof node.value === "boolean") return node.value ? "TRUE" : "FALSE"
        if (typeof node.value === "number") return String(node.value)
        return `'${escapeStringLiteral(String(node.value))}'`
      case "raw":
        this.params.push(...node.params)
        return node.sql
      case "column_ref":
        return node.table
          ? `${quoteIdentifier(node.table, this.dialect)}.${quoteIdentifier(node.column, this.dialect)}`
          : quoteIdentifier(node.column, this.dialect)
      case "function_call":
        return `${node.name}(${node.args.map((a) => this.printExpr(a)).join(", ")})`
      default:
        return "(?)"
    }
  }
}
