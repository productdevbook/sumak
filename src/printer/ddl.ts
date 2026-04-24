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
import { escapeStringLiteral, validateDataType, validateFunctionName } from "../utils/security.ts"

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

  /**
   * SQL Server rejects `IF NOT EXISTS` on every CREATE flavor released
   * as of SQL Server 2022 (preview 2025 adds it for CREATE TABLE only).
   * Refuse at print time with a pointer at the `IF NOT EXISTS(SELECT …)`
   * wrapper pattern, rather than emitting unexecutable DDL.
   */
  private guardIfNotExistsOnMssql(kind: string, ifNotExists: boolean | undefined): void {
    if (ifNotExists && this.dialect === "mssql") {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        `${kind} IF NOT EXISTS — wrap in IF NOT EXISTS(SELECT * FROM sys.<catalog> WHERE name = '…') BEGIN … END`,
      )
    }
  }

  private printCreateSchema(node: CreateSchemaNode): string {
    this.guardIfNotExistsOnMssql("CREATE SCHEMA", node.ifNotExists)
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
    this.guardIfNotExistsOnMssql("CREATE TABLE", node.ifNotExists)
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
    // Dialect-specific auto-increment keyword. Previously this method
    // only emitted on MySQL and silently dropped the flag on pg /
    // sqlite / mssql, shipping a plain PK column that required explicit
    // IDs at INSERT time. Each dialect has a different spelling; do
    // the translation here so `.autoIncrement()` behaves consistently.
    let dataType = col.dataType
    const trailingTokens: string[] = []
    if (col.autoIncrement) {
      switch (this.dialect) {
        case "mysql":
          trailingTokens.push("AUTO_INCREMENT")
          break
        case "mssql":
          trailingTokens.push("IDENTITY(1,1)")
          break
        case "pg": {
          // Rewrite bare integer types to their SERIAL variants —
          // matches how `serial()/bigserial()` on the schema layer
          // already works. `GENERATED BY DEFAULT AS IDENTITY` is an
          // alternative but SERIAL is still the widely-deployed form.
          const upper = dataType.trim().toUpperCase()
          if (upper === "INTEGER" || upper === "INT") dataType = "SERIAL"
          else if (upper === "BIGINT") dataType = "BIGSERIAL"
          else if (upper === "SMALLINT") dataType = "SMALLSERIAL"
          // Any other type (text/bool/etc.) + autoIncrement is user
          // error; leave as-is and let the DB reject it.
          break
        }
        case "sqlite":
          // SQLite's `AUTOINCREMENT` requires `INTEGER PRIMARY KEY`.
          // We can't know here whether the column is the PK (that flag
          // is on `col.primaryKey` above) but the common case is to
          // combine them. Emit only when PK is set.
          if (col.primaryKey) trailingTokens.push("AUTOINCREMENT")
          break
      }
    }
    // Validate the final (post-autoIncrement-rewrite) data type before
    // splicing into DDL. Without this, `addColumn("x", "INT; DROP
    // TABLE …")` would land verbatim in CREATE TABLE. CAST paths
    // already validate; the DDL path was missed.
    validateDataType(dataType)
    const parts: string[] = [quoteIdentifier(col.name, this.dialect), dataType]
    if (col.primaryKey) parts.push("PRIMARY KEY")
    if (trailingTokens.length > 0) parts.push(...trailingTokens)
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

    // Some actions need a complete standalone statement on certain
    // dialects (MSSQL rename → `EXEC sp_rename …`; PG rename lives
    // under `ALTER TABLE` but has restrictions). Split the action list
    // into "ALTER TABLE … <clause>" chunks and "bare statement" chunks.
    // Clauses for the same ALTER TABLE target get comma-joined on the
    // dialects that support it (PG/MySQL); MSSQL and SQLite still
    // require separate statements.
    const clauses: string[] = []
    const standalone: string[] = []

    for (const action of node.actions) {
      switch (action.kind) {
        case "add_column":
          clauses.push(`ADD COLUMN ${this.printColumnDef(action.column)}`)
          break
        case "drop_column":
          clauses.push(`DROP COLUMN ${quoteIdentifier(action.column, this.dialect)}`)
          break
        case "rename_column": {
          // SQL Server has no `ALTER TABLE … RENAME COLUMN` at all;
          // the idiomatic form is `EXEC sp_rename '<t>.<from>',
          // '<to>', 'COLUMN'`. All three args are SQL string literals;
          // escape via the same routine every other literal goes
          // through.
          //
          // INVARIANT: `node.table.schema` / `node.table.name` are
          // the RAW (unquoted) identifiers as they exist in the
          // database catalog. Do not pass bracket-quoted forms — the
          // surrounding `N'…'` literal would contain the brackets
          // verbatim and sp_rename would reject the nonexistent
          // `[dbo].[users]` object.
          if (this.dialect === "mssql") {
            const target = node.table.schema
              ? `${node.table.schema}.${node.table.name}.${action.from}`
              : `${node.table.name}.${action.from}`
            standalone.push(
              `EXEC sp_rename N'${escapeStringLiteral(target)}', N'${escapeStringLiteral(action.to)}', N'COLUMN'`,
            )
          } else {
            clauses.push(
              `RENAME COLUMN ${quoteIdentifier(action.from, this.dialect)} TO ${quoteIdentifier(action.to, this.dialect)}`,
            )
          }
          break
        }
        case "rename_table": {
          if (this.dialect === "mssql") {
            const target = node.table.schema
              ? `${node.table.schema}.${node.table.name}`
              : node.table.name
            standalone.push(
              `EXEC sp_rename N'${escapeStringLiteral(target)}', N'${escapeStringLiteral(action.to)}'`,
            )
          } else {
            clauses.push(`RENAME TO ${quoteIdentifier(action.to, this.dialect)}`)
          }
          break
        }
        case "alter_column": {
          // NOTE: PG-only syntax. MySQL/MSSQL need MODIFY/ALTER COLUMN
          // with full type; SQLite doesn't support any of these. Those
          // dialect rewrites are tracked separately (see audit #22).
          const sub: string[] = ["ALTER COLUMN", quoteIdentifier(action.column, this.dialect)]
          switch (action.set.type) {
            case "set_not_null":
              sub.push("SET NOT NULL")
              break
            case "drop_not_null":
              sub.push("DROP NOT NULL")
              break
            case "set_default":
              sub.push("SET DEFAULT", this.printExpr(action.set.value))
              break
            case "drop_default":
              sub.push("DROP DEFAULT")
              break
            case "set_data_type":
              validateDataType(action.set.dataType)
              sub.push("SET DATA TYPE", action.set.dataType)
              break
          }
          clauses.push(sub.join(" "))
          break
        }
        case "add_constraint":
          clauses.push(`ADD ${this.printConstraint(action.constraint)}`)
          break
        case "drop_constraint":
          clauses.push(`DROP CONSTRAINT ${quoteIdentifier(action.name, this.dialect)}`)
          break
      }
    }

    const statements: string[] = []
    if (clauses.length > 0) {
      // pg and MySQL both accept comma-separated multi-action ALTER TABLE
      // (atomic; the ANSI form). SQLite permits only one action per
      // ALTER TABLE; MSSQL permits multiples only within a subset
      // (ADD COLUMN, DROP COLUMN) — safer to emit one-per-statement.
      const canBatch = this.dialect === "pg" || this.dialect === "mysql"
      if (canBatch) {
        statements.push(`ALTER TABLE ${tableName} ${clauses.join(", ")}`)
      } else {
        for (const c of clauses) statements.push(`ALTER TABLE ${tableName} ${c}`)
      }
    }
    for (const s of standalone) statements.push(s)
    return statements.join("; ")
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
    this.guardIfNotExistsOnMssql("CREATE INDEX", node.ifNotExists)
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
    // `DROP INDEX <name> ON <table>` is MySQL / MSSQL syntax. PG and
    // SQLite reject the `ON <table>` clause at parse time — the index
    // name is globally unique there. We silently ignore `node.table`
    // on those dialects so a dialect-agnostic diff plan replays.
    if (node.table && (this.dialect === "mysql" || this.dialect === "mssql")) {
      parts.push("ON", quoteIdentifier(node.table, this.dialect))
    }
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
    if (node.orReplace && node.ifNotExists) {
      // PG / MySQL reject the combination; most dialects treat the two
      // as mutually exclusive. Catch it at print time rather than ship
      // a statement the database will refuse.
      throw new Error(
        "CREATE VIEW: OR REPLACE and IF NOT EXISTS are mutually exclusive — " +
          "pick one (OR REPLACE overwrites, IF NOT EXISTS leaves the existing view).",
      )
    }
    const parts: string[] = ["CREATE"]
    if (node.orReplace) {
      if (this.dialect === "mssql") {
        throw new UnsupportedDialectFeatureError(
          "mssql",
          "CREATE OR REPLACE VIEW (MSSQL has no OR REPLACE — use ALTER VIEW instead)",
        )
      }
      if (this.dialect === "sqlite") {
        throw new UnsupportedDialectFeatureError(
          "sqlite",
          "CREATE OR REPLACE VIEW (use DROP VIEW IF EXISTS + CREATE VIEW, or CREATE VIEW IF NOT EXISTS)",
        )
      }
      parts.push("OR REPLACE")
    }
    if (node.materialized && this.dialect !== "pg") {
      // PG and Oracle support materialized views; MySQL / SQLite / MSSQL
      // do not. Refuse instead of emitting a statement the driver rejects.
      throw new UnsupportedDialectFeatureError(
        this.dialect,
        "MATERIALIZED VIEW (PG-only — use a regular view or a table cache on other dialects)",
      )
    }
    if (node.temporary) parts.push("TEMPORARY")
    if (node.materialized) parts.push("MATERIALIZED")
    parts.push("VIEW")
    this.guardIfNotExistsOnMssql("CREATE VIEW", node.ifNotExists)
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
    // DDL expression contexts: CHECK, DEFAULT, GENERATED ALWAYS AS,
    // partial-index WHERE. None of these go through param binding —
    // whatever this returns is spliced into emitted DDL verbatim.
    switch (node.type) {
      case "literal":
        if (node.value === null) return "NULL"
        if (typeof node.value === "boolean") {
          // SQL Server has no boolean type — emit 1/0 (BIT domain).
          if (this.dialect === "mssql") return node.value ? "1" : "0"
          return node.value ? "TRUE" : "FALSE"
        }
        if (typeof node.value === "number") return String(node.value)
        return `'${escapeStringLiteral(String(node.value))}'`
      case "raw":
        this.params.push(...node.params)
        return node.sql
      case "column_ref":
        return node.table
          ? `${quoteIdentifier(node.table, this.dialect)}.${quoteIdentifier(node.column, this.dialect)}`
          : quoteIdentifier(node.column, this.dialect)
      case "function_call": {
        // `BasePrinter.printFunctionCall` validates the name; DDL used
        // to skip that, letting arbitrary strings through a DEFAULT /
        // CHECK clause. Mirror the validation so a hand-crafted AST
        // with `fn("foo(); DROP …", [])` cannot corrupt DDL output.
        validateFunctionName(node.name)
        return `${node.name}(${node.args.map((a) => this.printExpr(a)).join(", ")})`
      }
      case "binary_op":
        return `(${this.printExpr(node.left)} ${node.op} ${this.printExpr(node.right)})`
      case "unary_op":
        return node.position === "postfix"
          ? `(${this.printExpr(node.operand)} ${node.op})`
          : `(${node.op} ${this.printExpr(node.operand)})`
      case "is_null":
        return `(${this.printExpr(node.expr)} IS${node.negated ? " NOT" : ""} NULL)`
      case "between": {
        const neg = node.negated ? "NOT " : ""
        return `(${this.printExpr(node.expr)} ${neg}BETWEEN ${this.printExpr(node.low)} AND ${this.printExpr(node.high)})`
      }
      case "in": {
        if (!Array.isArray(node.values)) {
          // Subquery IN is not supportable in a DDL expression context
          // without bringing the full BasePrinter.printSelect pipeline
          // along — refuse and point at raw SQL.
          throw new Error(
            "DDLPrinter: IN (subquery) is not supported in DDL contexts — use raw SQL.",
          )
        }
        const neg = node.negated ? "NOT " : ""
        const vals = node.values.map((v) => this.printExpr(v)).join(", ")
        return `(${this.printExpr(node.expr)} ${neg}IN (${vals}))`
      }
      default:
        // Refuse unknown expression types in DDL rather than emit `(?)`
        // (which becomes a literal question-mark in the SQL text and
        // either breaks the driver or — worse — silently binds an
        // unrelated parameter). Pushes the user at a supported form.
        throw new Error(
          `DDLPrinter does not support expression type "${(node as { type: string }).type}" ` +
            "in DDL contexts (CHECK/DEFAULT/WHERE). Use sql`<raw sql>` via sql.unsafe() for complex expressions.",
        )
    }
  }
}
