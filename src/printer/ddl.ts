import type {
  AlterSequenceNode,
  AlterTableNode,
  AnalyzeNode,
  ColumnDefinitionNode,
  CommentNode,
  CreateExtensionNode,
  CreateIndexNode,
  CreatePolicyNode,
  CreateSchemaNode,
  CreateSequenceNode,
  CreateTableNode,
  CreateViewNode,
  DDLNode,
  DropExtensionNode,
  DropIndexNode,
  DropPolicyNode,
  DropSchemaNode,
  DropSequenceNode,
  DropTableNode,
  DropViewNode,
  ExcludeConstraintNode,
  ForeignKeyConstraintNode,
  RefreshMaterializedViewNode,
  ReindexNode,
  TableConstraintNode,
  TruncateTableNode,
  VacuumNode,
} from "../ast/ddl-nodes.ts"
import type { SelectNode } from "../ast/nodes.ts"
import { assertFeature } from "../dialect/features.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import type { CompiledQuery, SQLDialect } from "../types.ts"
import { quoteIdentifier, quoteTableRef } from "../utils/identifier.ts"
import {
  escapeStringLiteral,
  validateDataType,
  validateExtensionName,
  validateExtensionVersion,
  validateFunctionName,
  validateOperator,
} from "../utils/security.ts"

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
      case "refresh_materialized_view":
        return this.printRefreshMaterializedView(node)
      case "truncate_table":
        return this.printTruncateTable(node)
      case "create_schema":
        return this.printCreateSchema(node)
      case "drop_schema":
        return this.printDropSchema(node)
      case "comment_on":
        return this.printCommentOn(node)
      case "create_sequence":
        return this.printCreateSequence(node)
      case "drop_sequence":
        return this.printDropSequence(node)
      case "alter_sequence":
        return this.printAlterSequence(node)
      case "vacuum":
        return this.printVacuum(node)
      case "analyze":
        return this.printAnalyze(node)
      case "reindex":
        return this.printReindex(node)
      case "create_policy":
        return this.printCreatePolicy(node)
      case "drop_policy":
        return this.printDropPolicy(node)
      case "create_extension":
        return this.printCreateExtension(node)
      case "drop_extension":
        return this.printDropExtension(node)
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

  private printCreateExtension(node: CreateExtensionNode): string {
    // Only PG has CREATE EXTENSION. The other dialects either ship
    // extensions via different mechanisms (MySQL `INSTALL PLUGIN`,
    // MSSQL CLR / linked-server config — neither is DDL) or don't
    // surface anything comparable in SQL at all (SQLite loads
    // extensions through the C API, not a SQL statement). Refuse
    // up front rather than emit DDL the engine will reject.
    assertFeature(this.dialect, "EXTENSIONS")
    // Name lands unquoted (PG-style identifier) but we still gate it
    // through a stricter regex than `quoteIdentifier` would — the
    // unquoted-identifier slot can't safely hold attacker-controlled
    // input, so reject anything that isn't a plain identifier
    // (alphanumerics + underscore + hyphen, since `uuid-ossp` is real).
    validateExtensionName(node.name)
    const parts: string[] = ["CREATE EXTENSION"]
    if (node.ifNotExists) parts.push("IF NOT EXISTS")
    parts.push(quoteIdentifier(node.name, this.dialect))
    if (node.schema) {
      parts.push("SCHEMA", quoteIdentifier(node.schema, this.dialect))
    }
    if (node.version !== undefined) {
      validateExtensionVersion(node.version)
      parts.push("VERSION", `'${escapeStringLiteral(node.version)}'`)
    }
    if (node.cascade) parts.push("CASCADE")
    return parts.join(" ")
  }

  private printDropExtension(node: DropExtensionNode): string {
    assertFeature(this.dialect, "EXTENSIONS")
    if (node.names.length === 0) {
      // The builder constructor always seeds at least one name, but a
      // hand-rolled AST could land here. PG would reject `DROP EXTENSION
      // ;` with a syntax error — surface that as a clearer message.
      throw new Error("DROP EXTENSION requires at least one extension name.")
    }
    if (node.cascade && node.restrict) {
      // The builder normalizes this to "last call wins" but a
      // hand-built node could still set both flags. PG would error
      // anyway; bail with a useful diagnostic before emitting.
      throw new Error("DROP EXTENSION: CASCADE and RESTRICT are mutually exclusive.")
    }
    for (const n of node.names) validateExtensionName(n)
    const parts: string[] = ["DROP EXTENSION"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(node.names.map((n) => quoteIdentifier(n, this.dialect)).join(", "))
    if (node.cascade) parts.push("CASCADE")
    if (node.restrict) parts.push("RESTRICT")
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
    if (col.unique) {
      if (col.uniqueNullsNotDistinct) {
        // PG 15+ — at most one NULL per unique column. Other dialects
        // either treat NULLs as not-equal (PG default, MySQL, SQLite) or
        // not-equal-and-rejected-as-duplicate (MSSQL allows at most one
        // NULL, but the syntax doesn't exist). Refuse rather than emit
        // a clause the engine will reject.
        if (this.dialect !== "pg") {
          throw new UnsupportedDialectFeatureError(
            this.dialect,
            "UNIQUE NULLS NOT DISTINCT (PG 15+ only)",
          )
        }
        parts.push("UNIQUE NULLS NOT DISTINCT")
      } else {
        parts.push("UNIQUE")
      }
    }
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
    // Inline column comment — MySQL only. PG has no inline form in
    // `CREATE TABLE`; the diff engine emits a follow-up `COMMENT ON
    // COLUMN` statement instead, so we leave the field alone on PG.
    // SQLite / MSSQL silently drop the inline comment (they're refused
    // at the standalone-CommentNode path; including the inline form in
    // CREATE TABLE would be a parse error or a no-op depending on the
    // engine, so we omit on those dialects too).
    if (col.comment !== undefined && this.dialect === "mysql") {
      parts.push("COMMENT", `'${escapeStringLiteral(col.comment)}'`)
    }
    return parts.join(" ")
  }

  private printConstraint(c: TableConstraintNode): string {
    const namePrefix = c.name ? `CONSTRAINT ${quoteIdentifier(c.name, this.dialect)} ` : ""
    switch (c.type) {
      case "pk_constraint":
        return `${namePrefix}PRIMARY KEY (${c.columns.map((col) => quoteIdentifier(col, this.dialect)).join(", ")})`
      case "unique_constraint": {
        const cols = c.columns.map((col) => quoteIdentifier(col, this.dialect)).join(", ")
        if (c.nullsNotDistinct) {
          // PG 15+ `UNIQUE NULLS NOT DISTINCT` — treat NULLs as equal so
          // at most one row may have NULL in any of the columns. The
          // keyword goes BEFORE the column list per PG grammar.
          if (this.dialect !== "pg") {
            throw new UnsupportedDialectFeatureError(
              this.dialect,
              "UNIQUE NULLS NOT DISTINCT (PG 15+ only)",
            )
          }
          return `${namePrefix}UNIQUE NULLS NOT DISTINCT (${cols})`
        }
        return `${namePrefix}UNIQUE (${cols})`
      }
      case "check_constraint":
        return `${namePrefix}CHECK (${this.printExpr(c.expression)})`
      case "fk_constraint":
        return this.printForeignKeyConstraint(c, namePrefix)
      case "exclude_constraint":
        return this.printExcludeConstraint(c, namePrefix)
    }
  }

  /**
   * Emit a PG `EXCLUDE` constraint:
   *
   *     EXCLUDE [USING <method>] (<expr> WITH <op>, <expr> WITH <op>, …)
   *     [WHERE (<predicate>)]
   *
   * Method defaults to `gist` when unset (the only access method that
   * supports the range-overlap operator `&&`). Operator tokens are
   * passed through `validateOperator` so an attacker-controlled AST
   * built via `{ type: "exclude_constraint", elements: [...] }` cannot
   * smuggle in extra DDL through the per-element `WITH <op>` slot.
   *
   * Refused on every non-PG dialect — none of MySQL / SQLite / MSSQL
   * have an equivalent constraint grammar; the closest match is a
   * unique partial index, which is a different shape and best
   * expressed via the partial-index API.
   */
  private printExcludeConstraint(c: ExcludeConstraintNode, namePrefix: string): string {
    assertFeature(this.dialect, "EXCLUDE_CONSTRAINTS")
    const method = c.method ?? "gist"
    // Method is an identifier — same shape as `CREATE INDEX … USING <method>`.
    validateFunctionName(method)
    const elements = c.elements.map((e) => {
      validateOperator(e.operator)
      return `${this.printExpr(e.expr)} WITH ${e.operator}`
    })
    let out = `${namePrefix}EXCLUDE USING ${method} (${elements.join(", ")})`
    if (c.where) {
      out += ` WHERE (${this.printExpr(c.where)})`
    }
    return out
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
              if (action.set.using) {
                // `USING <expr>` — PG-only. On other dialects we
                // silently drop the clause (MSSQL / MySQL accept a
                // bare ALTER COLUMN TYPE and either succeed with
                // implicit cast or fail on bad data). Emitting
                // `USING` on MSSQL would be a parse error.
                if (this.dialect === "pg") {
                  sub.push("USING", this.printExpr(action.set.using))
                }
              }
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
        case "set_rls": {
          // PG only — no other dialect has equivalent grammar for
          // toggling per-row access control on a table. Refuse early
          // so the error points at the builder call rather than
          // surfacing as a parse failure at the engine.
          assertFeature(this.dialect, "ROW_LEVEL_SECURITY")
          switch (action.mode) {
            case "enable":
              clauses.push("ENABLE ROW LEVEL SECURITY")
              break
            case "disable":
              clauses.push("DISABLE ROW LEVEL SECURITY")
              break
            case "force":
              clauses.push("FORCE ROW LEVEL SECURITY")
              break
            case "no_force":
              clauses.push("NO FORCE ROW LEVEL SECURITY")
              break
          }
          break
        }
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
      // Partial / filtered index predicate. PG and SQLite (3.8+) both
      // accept the standard `CREATE INDEX … WHERE <expr>` form with
      // identical grammar. MySQL has no equivalent at all. MSSQL has
      // "filtered indexes" with a similar WHERE clause, but the subset
      // of supported predicates is stricter (no UDFs, no subqueries,
      // BIT-typed columns only via `IS NOT NULL`, etc.) — rather than
      // emit something MSSQL parses but silently rejects on edge cases,
      // we refuse and point at the dialect-specific recipe.
      assertFeature(this.dialect, "PARTIAL_INDEX")
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
    if ((node.orReplace || node.orAlter) && node.ifNotExists) {
      // PG / MySQL reject the combination; most dialects treat the two
      // as mutually exclusive. Catch it at print time rather than ship
      // a statement the database will refuse.
      throw new Error(
        "CREATE VIEW: OR REPLACE / OR ALTER and IF NOT EXISTS are mutually exclusive — " +
          "pick one (OR REPLACE/ALTER overwrites, IF NOT EXISTS leaves the existing view).",
      )
    }
    if (node.orReplace && node.orAlter) {
      // The two flags are mutually exclusive — `orReplace` is the
      // PG/MySQL form, `orAlter` is the MSSQL form. Setting both is
      // a builder-side mistake (e.g. chaining both methods).
      throw new Error(
        "CREATE VIEW: .orReplace() (PG/MySQL) and .orAlter() (MSSQL) " +
          "are mutually exclusive — pick the one matching your dialect.",
      )
    }
    if (node.orReplace) {
      // SQL Server has no `OR REPLACE` keyword at all. SQLite likewise
      // has no `OR REPLACE` form for views. PG / MySQL emit the
      // standard syntax. MSSQL users want `.orAlter()` (which compiles
      // to `CREATE OR ALTER VIEW`); SQLite users need DROP+CREATE.
      if (this.dialect === "mssql") {
        throw new UnsupportedDialectFeatureError(
          "mssql",
          "CREATE OR REPLACE VIEW (SQL Server has no OR REPLACE — call .orAlter() to emit CREATE OR ALTER VIEW instead)",
        )
      }
      if (this.dialect === "sqlite") {
        throw new UnsupportedDialectFeatureError(
          "sqlite",
          "CREATE OR REPLACE VIEW (use DROP VIEW IF EXISTS + CREATE VIEW, or CREATE VIEW IF NOT EXISTS)",
        )
      }
    }
    if (node.orAlter && this.dialect !== "mssql") {
      // `OR ALTER` is SQL-Server-specific (since 2016 SP1). PG / MySQL
      // use `OR REPLACE`; SQLite has neither. Reject loudly so the
      // builder caller knows to pick the right method per dialect.
      throw new UnsupportedDialectFeatureError(
        this.dialect,
        `CREATE OR ALTER VIEW (MSSQL-only — use .orReplace() on PG/MySQL${
          this.dialect === "sqlite" ? ", or DROP VIEW IF EXISTS + CREATE VIEW on SQLite" : ""
        })`,
      )
    }
    if (node.materialized && this.dialect !== "pg") {
      // PG and Oracle support materialized views; MySQL / SQLite / MSSQL
      // do not. Refuse instead of emitting a statement the driver rejects.
      throw new UnsupportedDialectFeatureError(
        this.dialect,
        "MATERIALIZED VIEW (PG-only — use a regular view or a table cache on other dialects)",
      )
    }

    const parts: string[] = node.orAlter ? ["CREATE OR ALTER"] : ["CREATE"]
    if (node.orReplace) parts.push("OR REPLACE")
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

    // `WITH [NO] DATA` — PG MATERIALIZED VIEW only. The default at PG
    // is `WITH DATA` (populate at creation); we only emit the explicit
    // tail when the user opted into `WITH NO DATA`. Silently dropped
    // on non-materialized views and non-PG dialects: a plain VIEW has
    // no storage to populate, so the clause is meaningless.
    if (node.materialized && this.dialect === "pg" && node.withData === false) {
      parts.push("WITH NO DATA")
    }
    return parts.join(" ")
  }

  private printRefreshMaterializedView(node: RefreshMaterializedViewNode): string {
    // `REFRESH MATERIALIZED VIEW` is PG-only — MySQL / SQLite / MSSQL
    // have no materialized views in the first place. Refuse via the
    // matrix rather than emit SQL the driver rejects at parse.
    assertFeature(this.dialect, "MATERIALIZED_VIEW")
    const parts: string[] = ["REFRESH MATERIALIZED VIEW"]
    if (node.concurrently) {
      // `CONCURRENTLY` requires a UNIQUE index on the view's projected
      // rows; without it PG raises at execution time, not at parse. We
      // don't have the catalog to check that here, so emit the keyword
      // verbatim and let PG surface the runtime error.
      assertFeature(this.dialect, "MATERIALIZED_VIEW_CONCURRENT_REFRESH")
      parts.push("CONCURRENTLY")
    }
    const viewName = node.schema
      ? `${quoteIdentifier(node.schema, this.dialect)}.${quoteIdentifier(node.name, this.dialect)}`
      : quoteIdentifier(node.name, this.dialect)
    parts.push(viewName)
    if (node.withData === false) {
      // `WITH NO DATA` — empties the view's storage after the refresh.
      // Mutually exclusive with `CONCURRENTLY` at the PG side (the
      // concurrent path is precisely "swap new data in"); the driver
      // surfaces that conflict directly, so we don't pre-empt it here.
      parts.push("WITH NO DATA")
    }
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
      // SQLite has no TRUNCATE TABLE — DELETE FROM is the workaround.
      // Note the semantic gap: TRUNCATE doesn't fire row triggers and
      // can be non-transactional, while DELETE FROM fires triggers and
      // is fully transactional. SQLite 3.6.5+ does optimise an
      // unconditional `DELETE FROM tab` to a TRUNCATE-like fast path
      // internally, so the perf characteristics are usually close, but
      // we refuse rather than silently rewrite — the caller should
      // make that choice explicitly.
      throw new UnsupportedDialectFeatureError(
        "sqlite",
        "TRUNCATE TABLE (SQLite has no TRUNCATE — use `db.deleteFrom(t).allRows()`)",
      )
    }
    if (node.tables.length === 0) {
      throw new Error("TRUNCATE TABLE requires at least one table.")
    }
    if (node.cascade && node.restrict) {
      throw new Error("TRUNCATE TABLE: cascade and restrict are mutually exclusive — set only one.")
    }
    if (node.restartIdentity && node.continueIdentity) {
      throw new Error(
        "TRUNCATE TABLE: restartIdentity and continueIdentity are mutually exclusive — set only one.",
      )
    }

    // Multi-table is PG-only. MySQL / MSSQL accept exactly one table
    // per statement; refuse before we render any partial SQL.
    const isPg = this.dialect === "pg"
    if (node.tables.length > 1 && !isPg) {
      throw new UnsupportedDialectFeatureError(
        this.dialect,
        "TRUNCATE TABLE with multiple tables (PG only — emit one statement per table on MySQL / MSSQL)",
      )
    }

    // All PG-specific modifiers refuse on MySQL / MSSQL with a hint at
    // the right escape hatch.
    if (!isPg) {
      if (node.only) {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "TRUNCATE ONLY (PG only — MySQL / MSSQL have no table inheritance)",
        )
      }
      if (node.restartIdentity) {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "TRUNCATE ... RESTART IDENTITY (use DBCC CHECKIDENT on MSSQL, ALTER TABLE AUTO_INCREMENT on MySQL)",
        )
      }
      if (node.continueIdentity) {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "TRUNCATE ... CONTINUE IDENTITY (PG only — the default behaviour is already 'continue' on MySQL / MSSQL)",
        )
      }
      if (node.cascade) {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "TRUNCATE ... CASCADE (truncate dependent tables manually)",
        )
      }
      if (node.restrict) {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "TRUNCATE ... RESTRICT (PG only — RESTRICT is the implicit default on MySQL / MSSQL)",
        )
      }
    }

    const parts: string[] = ["TRUNCATE TABLE"]
    if (node.only) parts.push("ONLY")
    const refs = node.tables.map((t) => quoteTableRef(t.name, this.dialect, t.schema))
    parts.push(refs.join(", "))
    // CONTINUE IDENTITY / RESTRICT are SQL defaults — omit when set so
    // the emitted SQL is compact. RESTART IDENTITY and CASCADE are
    // emitted explicitly when set.
    if (node.restartIdentity) parts.push("RESTART IDENTITY")
    if (node.cascade) parts.push("CASCADE")
    return parts.join(" ")
  }

  private printCommentOn(node: CommentNode): string {
    // PG and MySQL only — SQLite has no equivalent, MSSQL uses the
    // separate `sp_addextendedproperty` stored-procedure surface that
    // sumak doesn't bridge. Refuse loudly rather than ship a no-op or
    // half-correct SQL.
    if (this.dialect === "sqlite" || this.dialect === "mssql") {
      // MSSQL gets a pointer at the right escape hatch in the error
      // message; SQLite has no equivalent at all and the generic label
      // covers it.
      assertFeature(this.dialect, "OBJECT_COMMENTS")
    }
    const literal = node.comment === null ? "NULL" : `'${escapeStringLiteral(node.comment)}'`

    if (this.dialect === "pg") {
      if (node.target === "table") {
        return `COMMENT ON TABLE ${quoteIdentifier(node.tableName, this.dialect)} IS ${literal}`
      }
      // Column comment: requires the column name.
      if (!node.columnName) {
        throw new Error("CommentNode target='column' requires columnName — got undefined.")
      }
      return `COMMENT ON COLUMN ${quoteIdentifier(node.tableName, this.dialect)}.${quoteIdentifier(node.columnName, this.dialect)} IS ${literal}`
    }

    // MySQL path. For table comments the idiomatic form is `ALTER
    // TABLE … COMMENT = '…'`. For column comments MySQL has no
    // standalone statement — `ALTER TABLE … MODIFY COLUMN <col> <type>
    // COMMENT '…'` requires knowing the column's current type, which
    // we don't carry through to this layer. Refuse at print time and
    // point the caller at the inline form on CREATE TABLE / the
    // typed-builder ALTER COLUMN path (future work).
    if (node.target === "table") {
      const valueLiteral = node.comment === null ? "''" : `'${escapeStringLiteral(node.comment)}'`
      return `ALTER TABLE ${quoteIdentifier(node.tableName, this.dialect)} COMMENT = ${valueLiteral}`
    }
    throw new UnsupportedDialectFeatureError(
      "mysql",
      "standalone COMMENT ON COLUMN (MySQL requires ALTER TABLE … MODIFY COLUMN <name> <type> COMMENT '…' with the column's full type; use the inline `.comment(\"…\")` form on the column when defining the table instead)",
    )
  }

  /**
   * Emit `CREATE SEQUENCE [IF NOT EXISTS] <name>
   *   [AS <type>] [INCREMENT BY n] [MINVALUE n | NO MINVALUE]
   *   [MAXVALUE n | NO MAXVALUE] [START WITH n] [CACHE n]
   *   [CYCLE | NO CYCLE] [OWNED BY t.c | NONE]`.
   *
   * PG and MSSQL diverge on:
   *  - `IF NOT EXISTS` — PG only; MSSQL has no first-class form.
   *  - `OWNED BY` — PG only.
   *  - Negative `start` / bounds — both accept (PG requires they sit in
   *    the data-type range; we don't gate that ahead of time).
   *
   * Identifier handling: the data type and identifier slots are
   * validated through `validateDataType` / `quoteIdentifier`. The
   * numeric slots are formatted via `String(n)` after a finite-integer
   * check (a non-integer would be a Number cast to int by the engine
   * and silently round, which is worse than a clear error).
   */
  private printCreateSequence(node: CreateSequenceNode): string {
    // Refuse on MySQL / SQLite — neither has a sequence object at all.
    assertFeature(this.dialect, "SEQUENCES")
    if (node.ifNotExists && this.dialect === "mssql") {
      throw new UnsupportedDialectFeatureError(
        "mssql",
        "CREATE SEQUENCE IF NOT EXISTS — wrap in IF NOT EXISTS(SELECT * FROM sys.sequences WHERE name = '…') BEGIN … END",
      )
    }
    if (node.ownedBy !== undefined && this.dialect !== "pg") {
      throw new UnsupportedDialectFeatureError(
        this.dialect,
        "CREATE SEQUENCE … OWNED BY (PG-only; sequences on MSSQL aren't auto-dropped with their column)",
      )
    }

    const parts: string[] = ["CREATE SEQUENCE"]
    if (node.ifNotExists) parts.push("IF NOT EXISTS")
    parts.push(this.qualifiedName(node.name, node.schema))

    if (node.dataType !== undefined) {
      // Re-use the existing validator — `AS bigint` follows the same
      // grammar as a column data type. Refusing anything outside the
      // SAFE_DATA_TYPE_RE here blocks attacker-built ASTs from smuggling
      // extra DDL through the unquoted-type slot.
      validateDataType(node.dataType)
      parts.push("AS", node.dataType)
    }

    if (node.increment !== undefined) {
      this.assertFiniteInteger("increment", node.increment)
      parts.push("INCREMENT BY", String(node.increment))
    }

    if (node.minValue === null) {
      parts.push("NO MINVALUE")
    } else if (node.minValue !== undefined) {
      this.assertFiniteInteger("minValue", node.minValue)
      parts.push("MINVALUE", String(node.minValue))
    }

    if (node.maxValue === null) {
      parts.push("NO MAXVALUE")
    } else if (node.maxValue !== undefined) {
      this.assertFiniteInteger("maxValue", node.maxValue)
      parts.push("MAXVALUE", String(node.maxValue))
    }

    if (node.start !== undefined) {
      this.assertFiniteInteger("start", node.start)
      parts.push("START WITH", String(node.start))
    }

    if (node.cache !== undefined) {
      this.assertFiniteInteger("cache", node.cache)
      parts.push("CACHE", String(node.cache))
    }

    if (node.cycle === true) parts.push("CYCLE")
    else if (node.cycle === false) parts.push("NO CYCLE")

    if (node.ownedBy !== undefined) {
      // Guarded above — only PG reaches here.
      if (node.ownedBy === "NONE") {
        parts.push("OWNED BY NONE")
      } else {
        parts.push(
          "OWNED BY",
          `${quoteIdentifier(node.ownedBy.table, this.dialect)}.${quoteIdentifier(node.ownedBy.column, this.dialect)}`,
        )
      }
    }

    return parts.join(" ")
  }

  /**
   * `DROP SEQUENCE [IF EXISTS] <name> [CASCADE]`. PG accepts CASCADE;
   * MSSQL rejects it (sequences aren't part of the referential graph
   * the way tables are), so the printer refuses if set on that
   * dialect.
   */
  private printDropSequence(node: DropSequenceNode): string {
    assertFeature(this.dialect, "SEQUENCES")
    const parts: string[] = ["DROP SEQUENCE"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(this.qualifiedName(node.name, node.schema))
    if (node.cascade) {
      if (this.dialect !== "pg") {
        throw new UnsupportedDialectFeatureError(
          this.dialect,
          "DROP SEQUENCE ... CASCADE (PG-only)",
        )
      }
      parts.push("CASCADE")
    }
    return parts.join(" ")
  }

  /**
   * Emit `ALTER SEQUENCE [IF EXISTS] <name>
   *   [AS <type>] [INCREMENT BY n] [MINVALUE n | NO MINVALUE]
   *   [MAXVALUE n | NO MAXVALUE] [START WITH n] [RESTART [WITH n]]
   *   [CACHE n | NO CACHE] [CYCLE | NO CYCLE] [OWNED BY t.c | NONE]`.
   *
   * Dialect divergence handled here:
   *
   *  - `IF EXISTS` — PG only on this statement. MSSQL has no
   *    first-class form on `ALTER SEQUENCE`; refuse with the same
   *    wrapper hint we use for `CREATE SEQUENCE`.
   *  - `AS <type>` — PG only on this statement. MSSQL has no grammar
   *    for changing the data type after creation.
   *  - `START WITH <n>` — PG only on this statement. MSSQL has no
   *    `START WITH` clause on `ALTER SEQUENCE` (use the CREATE-time
   *    setting, or `RESTART WITH` for value changes).
   *  - `OWNED BY` — PG only.
   *  - `NO CACHE` — MSSQL only. PG has no `NO CACHE` keyword on
   *    ALTER; pass `CACHE 1` (the implicit minimum) instead.
   *
   * If no option is set, the statement is meaningless — `ALTER
   * SEQUENCE <name>` with no clauses is a parse error on both PG and
   * MSSQL. Refuse early so the caller sees a clear builder-side error
   * rather than a cryptic database error.
   */
  private printAlterSequence(node: AlterSequenceNode): string {
    assertFeature(this.dialect, "SEQUENCES")

    // MSSQL-only refusals on ALTER SEQUENCE clauses.
    if (this.dialect === "mssql") {
      if (node.ifExists) {
        throw new UnsupportedDialectFeatureError(
          "mssql",
          "ALTER SEQUENCE IF EXISTS — wrap in IF EXISTS(SELECT * FROM sys.sequences WHERE name = '…') BEGIN … END",
        )
      }
      if (node.dataType !== undefined) {
        throw new UnsupportedDialectFeatureError(
          "mssql",
          "ALTER SEQUENCE … AS <type> (PG only; MSSQL has no grammar for changing the data type after creation — drop and recreate the sequence)",
        )
      }
      if (node.start !== undefined) {
        throw new UnsupportedDialectFeatureError(
          "mssql",
          "ALTER SEQUENCE … START WITH (PG only; MSSQL has no START WITH clause on ALTER — use .restartWith(n) to reset the current value, or set START WITH at CREATE time)",
        )
      }
      if (node.ownedBy !== undefined) {
        throw new UnsupportedDialectFeatureError(
          "mssql",
          "ALTER SEQUENCE … OWNED BY (PG only; sequences on MSSQL aren't auto-dropped with their column)",
        )
      }
    } else if (node.cache === null) {
      // `NO CACHE` is MSSQL-only on this statement — PG has no
      // equivalent keyword on ALTER. Refuse rather than silently emit
      // SQL that fails at parse time.
      throw new UnsupportedDialectFeatureError(
        this.dialect,
        "ALTER SEQUENCE … NO CACHE (MSSQL only; PG has no NO CACHE keyword on ALTER — use .cache(1) instead)",
      )
    }

    // Reject the all-defaults form early — both engines reject an
    // empty option list at parse, and a clearer error helps the caller
    // notice a no-op builder chain.
    if (!this.hasAnyAlterSequenceOption(node)) {
      throw new Error(
        "ALTER SEQUENCE requires at least one option — set increment / restart / cache / cycle / etc. before compiling.",
      )
    }

    const parts: string[] = ["ALTER SEQUENCE"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(this.qualifiedName(node.name, node.schema))

    if (node.dataType !== undefined) {
      validateDataType(node.dataType)
      parts.push("AS", node.dataType)
    }

    if (node.increment !== undefined) {
      this.assertFiniteInteger("increment", node.increment)
      parts.push("INCREMENT BY", String(node.increment))
    }

    if (node.minValue === null) {
      parts.push("NO MINVALUE")
    } else if (node.minValue !== undefined) {
      this.assertFiniteInteger("minValue", node.minValue)
      parts.push("MINVALUE", String(node.minValue))
    }

    if (node.maxValue === null) {
      parts.push("NO MAXVALUE")
    } else if (node.maxValue !== undefined) {
      this.assertFiniteInteger("maxValue", node.maxValue)
      parts.push("MAXVALUE", String(node.maxValue))
    }

    if (node.start !== undefined) {
      this.assertFiniteInteger("start", node.start)
      parts.push("START WITH", String(node.start))
    }

    if (node.restart !== undefined) {
      if (node.restart === true) {
        parts.push("RESTART")
      } else {
        this.assertFiniteInteger("restart", node.restart.value)
        parts.push("RESTART WITH", String(node.restart.value))
      }
    }

    if (node.cache === null) {
      // Guarded above on non-MSSQL — only MSSQL reaches here.
      parts.push("NO CACHE")
    } else if (node.cache !== undefined) {
      this.assertFiniteInteger("cache", node.cache)
      parts.push("CACHE", String(node.cache))
    }

    if (node.cycle === true) parts.push("CYCLE")
    else if (node.cycle === false) parts.push("NO CYCLE")

    if (node.ownedBy !== undefined) {
      // Guarded above — only PG reaches here.
      if (node.ownedBy === "NONE") {
        parts.push("OWNED BY NONE")
      } else {
        parts.push(
          "OWNED BY",
          `${quoteIdentifier(node.ownedBy.table, this.dialect)}.${quoteIdentifier(node.ownedBy.column, this.dialect)}`,
        )
      }
    }

    return parts.join(" ")
  }

  /**
   * Does the {@link AlterSequenceNode} carry at least one effective
   * option? Used to refuse the bare `ALTER SEQUENCE <name>` form,
   * which both engines reject at parse.
   */
  private hasAnyAlterSequenceOption(node: AlterSequenceNode): boolean {
    return (
      node.dataType !== undefined ||
      node.increment !== undefined ||
      node.minValue !== undefined ||
      node.maxValue !== undefined ||
      node.start !== undefined ||
      node.restart !== undefined ||
      node.cache !== undefined ||
      node.cycle !== undefined ||
      node.ownedBy !== undefined
    )
  }

  /** Shared schema-qualified name helper for sequence DDL. */
  private qualifiedName(name: string, schema?: string): string {
    return schema
      ? `${quoteIdentifier(schema, this.dialect)}.${quoteIdentifier(name, this.dialect)}`
      : quoteIdentifier(name, this.dialect)
  }

  /**
   * Reject non-finite / non-integer numeric values in sequence DDL.
   * The numbers go into the SQL text verbatim (no parameter binding —
   * DDL doesn't bind), so silently rounding a `1.5` to `1` would
   * mask a builder-side bug; failing fast points the caller at the
   * offending call site.
   */
  private assertFiniteInteger(field: string, value: number): void {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`SEQUENCE: ${field} must be a finite integer, got ${String(value)}.`)
    }
  }

  /**
   * Emit `VACUUM [ ( option, option, ... ) ] [ table [, table ...] ]`.
   *
   * PG-only; the printer refuses on MySQL / SQLite / MSSQL via the
   * `VACUUM_STMT` feature gate.
   *
   * Option ordering follows the PG documentation tour for stable
   * serialisation. Each option emits its keyword unconditionally when
   * set true; `truncate` is the only flag where the false form is
   * meaningful (`TRUNCATE FALSE` skips PG's default trailing-page
   * truncate), so the printer emits the explicit value when the slot
   * is set.
   */
  private printVacuum(node: VacuumNode): string {
    assertFeature(this.dialect, "VACUUM_STMT")
    const options: string[] = []
    if (node.full) options.push("FULL")
    if (node.freeze) options.push("FREEZE")
    if (node.verbose) options.push("VERBOSE")
    if (node.analyze) options.push("ANALYZE")
    if (node.skipLocked) options.push("SKIP_LOCKED")
    // `truncate` field controls both directions. PG's default is
    // `TRUNCATE TRUE`; we only emit when the slot is set.
    if (node.truncate !== undefined) {
      options.push(node.truncate ? "TRUNCATE" : "TRUNCATE FALSE")
    }
    const parts: string[] = ["VACUUM"]
    if (options.length > 0) parts.push(`(${options.join(", ")})`)
    if (node.tables && node.tables.length > 0) {
      parts.push(node.tables.map((t) => quoteIdentifier(t, this.dialect)).join(", "))
    }
    return parts.join(" ")
  }

  /**
   * Emit `ANALYZE [ ( option, option, ... ) ] [ table [, table ...] ]`.
   *
   * PG-only under this exact grammar; the printer refuses on MySQL /
   * SQLite / MSSQL.
   */
  private printAnalyze(node: AnalyzeNode): string {
    assertFeature(this.dialect, "ANALYZE_STMT")
    const options: string[] = []
    if (node.verbose) options.push("VERBOSE")
    if (node.skipLocked) options.push("SKIP_LOCKED")
    const parts: string[] = ["ANALYZE"]
    if (options.length > 0) parts.push(`(${options.join(", ")})`)
    if (node.tables && node.tables.length > 0) {
      parts.push(node.tables.map((t) => quoteIdentifier(t, this.dialect)).join(", "))
    }
    return parts.join(" ")
  }

  /**
   * Emit `REINDEX [ ( VERBOSE ) ] { INDEX | TABLE | SCHEMA | DATABASE
   * | SYSTEM } [CONCURRENTLY] <name>`.
   *
   * PG-only. The grammar puts the option list (just `VERBOSE` in the
   * supported first cut) *before* the target keyword and the
   * `CONCURRENTLY` flag goes *after* the target keyword but *before*
   * the name.
   *
   * `target` is type-restricted to the five PG keywords; the printer
   * still routes through a final switch to surface a clearer error if
   * an attacker-crafted AST passes anything else through. `name` is
   * quoted via `quoteIdentifier` so reserved words, mixed case, and
   * Unicode all survive verbatim.
   */
  private printReindex(node: ReindexNode): string {
    assertFeature(this.dialect, "REINDEX_STMT")
    // Defensive — the AST type narrows this, but a hand-built node
    // could smuggle in anything via `as unknown`. Surface a clear
    // error rather than emit a string PG will silently misinterpret.
    switch (node.target) {
      case "INDEX":
      case "TABLE":
      case "SCHEMA":
      case "DATABASE":
      case "SYSTEM":
        break
      default:
        throw new Error(
          `REINDEX: target must be one of INDEX / TABLE / SCHEMA / DATABASE / SYSTEM — got "${String(
            (node as { target: string }).target,
          )}".`,
        )
    }
    const parts: string[] = ["REINDEX"]
    if (node.verbose) parts.push("(VERBOSE)")
    parts.push(node.target)
    if (node.concurrently) parts.push("CONCURRENTLY")
    parts.push(quoteIdentifier(node.name, this.dialect))
    return parts.join(" ")
  }

  /**
   * Emit `CREATE POLICY <name> ON <table>
   *   [AS PERMISSIVE | RESTRICTIVE]
   *   [FOR { ALL | SELECT | INSERT | UPDATE | DELETE }]
   *   [TO role [, ...]]
   *   [USING (<expr>)]
   *   [WITH CHECK (<expr>)]`.
   *
   * PG only — refuses on every non-PG dialect via the
   * `ROW_LEVEL_SECURITY` feature gate.
   *
   * Mutually-exclusive flags:
   *
   *  - `permissive` + `restrictive` — set only one; PG accepts at most
   *    one `AS …` token. We refuse early when both are true.
   *
   * `forCommand` is type-restricted to the five PG keywords; the
   * `default` arm guards against hand-crafted ASTs that try to smuggle
   * other tokens through. Roles list passes through `quoteIdentifier`
   * except for the three reserved tokens `PUBLIC` / `CURRENT_USER` /
   * `SESSION_USER`, which PG accepts as bare keywords.
   */
  private printCreatePolicy(node: CreatePolicyNode): string {
    assertFeature(this.dialect, "ROW_LEVEL_SECURITY")
    if (node.permissive && node.restrictive) {
      throw new Error(
        "CREATE POLICY: permissive and restrictive are mutually exclusive — set only one.",
      )
    }
    if (!node.table) {
      throw new Error(
        `CREATE POLICY "${node.name}" requires a target table — call .on(table) before compiling.`,
      )
    }

    const parts: string[] = [
      "CREATE POLICY",
      quoteIdentifier(node.name, this.dialect),
      "ON",
      this.qualifiedName(node.table, node.schema),
    ]

    if (node.restrictive) parts.push("AS RESTRICTIVE")
    else if (node.permissive) parts.push("AS PERMISSIVE")

    if (node.forCommand !== undefined) {
      switch (node.forCommand) {
        case "ALL":
        case "SELECT":
        case "INSERT":
        case "UPDATE":
        case "DELETE":
          parts.push("FOR", node.forCommand)
          break
        default:
          throw new Error(
            `CREATE POLICY: forCommand must be one of ALL / SELECT / INSERT / UPDATE / DELETE — got "${String(
              (node as { forCommand: string }).forCommand,
            )}".`,
          )
      }
    }

    if (node.roles && node.roles.length > 0) {
      const rendered = node.roles.map((r) => this.renderPolicyRole(r))
      parts.push("TO", rendered.join(", "))
    }

    if (node.using !== undefined) {
      parts.push("USING", `(${this.printExpr(node.using)})`)
    }

    if (node.withCheck !== undefined) {
      parts.push("WITH CHECK", `(${this.printExpr(node.withCheck)})`)
    }

    return parts.join(" ")
  }

  /**
   * Emit `DROP POLICY [IF EXISTS] <name> ON <table> [CASCADE]`. PG
   * only.
   */
  private printDropPolicy(node: DropPolicyNode): string {
    assertFeature(this.dialect, "ROW_LEVEL_SECURITY")
    if (!node.table) {
      throw new Error(
        `DROP POLICY "${node.name}" requires a target table — call .on(table) before compiling.`,
      )
    }

    const parts: string[] = ["DROP POLICY"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(quoteIdentifier(node.name, this.dialect))
    parts.push("ON", this.qualifiedName(node.table, node.schema))
    if (node.cascade) parts.push("CASCADE")
    return parts.join(" ")
  }

  /**
   * Render a single entry in a CREATE POLICY `TO` list. The three
   * reserved keywords `PUBLIC` / `CURRENT_USER` / `SESSION_USER` pass
   * through verbatim (uppercased for stable output); anything else is
   * treated as a role identifier and quoted accordingly.
   */
  private renderPolicyRole(role: string): string {
    const upper = role.toUpperCase()
    if (upper === "PUBLIC" || upper === "CURRENT_USER" || upper === "SESSION_USER") {
      return upper
    }
    return quoteIdentifier(role, this.dialect)
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
      case "is_json": {
        const neg = node.negated ? " NOT" : ""
        const kind =
          node.kind === undefined
            ? ""
            : node.kind === "value"
              ? " VALUE"
              : node.kind === "scalar"
                ? " SCALAR"
                : node.kind === "array"
                  ? " ARRAY"
                  : " OBJECT"
        return `(${this.printExpr(node.expr)} IS${neg} JSON${kind})`
      }
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
