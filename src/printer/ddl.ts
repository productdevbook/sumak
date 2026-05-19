import type {
  AlterPolicyNode,
  AlterSequenceNode,
  AlterTableNode,
  AlterTypeAddValueNode,
  AlterTypeRenameNode,
  AlterTypeRenameValueNode,
  AnalyzeNode,
  ColumnDefinitionNode,
  CommentNode,
  CopyNode,
  CreateDomainNode,
  CreateExtensionNode,
  CreateIndexNode,
  CreatePolicyNode,
  CreateSchemaNode,
  CreateSequenceNode,
  CreateTableNode,
  CreateTypeEnumNode,
  CreateViewNode,
  DDLNode,
  DropDomainNode,
  DropExtensionNode,
  DropIndexNode,
  DropPolicyNode,
  DropSchemaNode,
  DropSequenceNode,
  DropTableNode,
  DropTypeNode,
  DropViewNode,
  ExcludeConstraintNode,
  ForeignKeyConstraintNode,
  ListenNode,
  LockTableNode,
  NotifyNode,
  RefreshMaterializedViewNode,
  ReindexNode,
  TableConstraintNode,
  TruncateTableNode,
  UnlistenNode,
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
      case "alter_policy":
        return this.printAlterPolicy(node)
      case "create_extension":
        return this.printCreateExtension(node)
      case "drop_extension":
        return this.printDropExtension(node)
      case "create_type_enum":
        return this.printCreateTypeEnum(node)
      case "drop_type":
        return this.printDropType(node)
      case "create_domain":
        return this.printCreateDomain(node)
      case "drop_domain":
        return this.printDropDomain(node)
      case "alter_type_add_value":
        return this.printAlterTypeAddValue(node)
      case "alter_type_rename":
        return this.printAlterTypeRename(node)
      case "alter_type_rename_value":
        return this.printAlterTypeRenameValue(node)
      case "lock_table":
        return this.printLockTable(node)
      case "copy":
        return this.printCopy(node)
      case "listen":
        return this.printListen(node)
      case "unlisten":
        return this.printUnlisten(node)
      case "notify":
        return this.printNotify(node)
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

  private printCreateTypeEnum(node: CreateTypeEnumNode): string {
    // Only PG has `CREATE TYPE … AS ENUM`. MySQL only has the inline
    // column shape (no `CREATE TYPE` grammar); SQLite has no enum
    // type; MSSQL's `CREATE TYPE` is an entirely different shape
    // (`AS TABLE` or `FROM existing_type`). Refuse up front rather
    // than emit DDL the engine will reject.
    assertFeature(this.dialect, "CUSTOM_TYPES")
    // Names land in the identifier slot — quoted by `quoteIdentifier`,
    // but we still gate via the stricter `validateFunctionName` regex
    // (alphanumerics + underscore, no hyphens) since enum type names
    // don't have the legacy hyphen carve-out that `validateExtensionName`
    // does. Anything outside the regex is rejected as injection.
    validateFunctionName(node.name)
    const escaped = node.values.map((v) => `'${escapeStringLiteral(v)}'`).join(", ")
    return `CREATE TYPE ${quoteIdentifier(node.name, this.dialect)} AS ENUM (${escaped})`
  }

  private printDropType(node: DropTypeNode): string {
    assertFeature(this.dialect, "CUSTOM_TYPES")
    if (node.names.length === 0) {
      throw new Error("DROP TYPE requires at least one type name.")
    }
    if (node.cascade && node.restrict) {
      throw new Error("DROP TYPE: CASCADE and RESTRICT are mutually exclusive.")
    }
    for (const n of node.names) validateFunctionName(n)
    const parts: string[] = ["DROP TYPE"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(node.names.map((n) => quoteIdentifier(n, this.dialect)).join(", "))
    if (node.cascade) parts.push("CASCADE")
    if (node.restrict) parts.push("RESTRICT")
    return parts.join(" ")
  }

  private printCreateDomain(node: CreateDomainNode): string {
    assertFeature(this.dialect, "CUSTOM_TYPES")
    if (!node.dataType) {
      throw new Error(
        `CREATE DOMAIN "${node.name}" requires a base data type — call .dataType(...) before compiling.`,
      )
    }
    validateFunctionName(node.name)
    validateDataType(node.dataType)
    const parts: string[] = [
      "CREATE DOMAIN",
      quoteIdentifier(node.name, this.dialect),
      "AS",
      node.dataType,
    ]
    if (node.defaultExpression !== undefined) {
      parts.push("DEFAULT", this.printExpr(node.defaultExpression))
    }
    if (node.notNull) parts.push("NOT NULL")
    if (node.check !== undefined) {
      if (node.checkConstraintName !== undefined) {
        validateFunctionName(node.checkConstraintName)
        parts.push("CONSTRAINT", quoteIdentifier(node.checkConstraintName, this.dialect))
      }
      parts.push("CHECK", `(${this.printExpr(node.check)})`)
    }
    return parts.join(" ")
  }

  private printDropDomain(node: DropDomainNode): string {
    assertFeature(this.dialect, "CUSTOM_TYPES")
    if (node.names.length === 0) {
      throw new Error("DROP DOMAIN requires at least one domain name.")
    }
    if (node.cascade && node.restrict) {
      throw new Error("DROP DOMAIN: CASCADE and RESTRICT are mutually exclusive.")
    }
    for (const n of node.names) validateFunctionName(n)
    const parts: string[] = ["DROP DOMAIN"]
    if (node.ifExists) parts.push("IF EXISTS")
    parts.push(node.names.map((n) => quoteIdentifier(n, this.dialect)).join(", "))
    if (node.cascade) parts.push("CASCADE")
    if (node.restrict) parts.push("RESTRICT")
    return parts.join(" ")
  }

  private printAlterTypeAddValue(node: AlterTypeAddValueNode): string {
    // Shares the `CUSTOM_TYPES` feature gate with `CREATE TYPE AS ENUM`
    // — the statement only exists on PG and only makes sense on a type
    // created via that shape.
    assertFeature(this.dialect, "CUSTOM_TYPES")
    if (node.value === "") {
      // Builders seed `value: ""` and require `.value(...)`; refuse with a
      // pointer at the missing call rather than emit `ADD VALUE ''` (which
      // PG would accept as a literal empty-string label — almost
      // certainly not what the caller meant).
      throw new Error(
        `ALTER TYPE "${node.name}" ADD VALUE requires a non-empty value — call .value(...) before compiling.`,
      )
    }
    validateFunctionName(node.name)
    const parts: string[] = ["ALTER TYPE", quoteIdentifier(node.name, this.dialect), "ADD VALUE"]
    if (node.ifNotExists) parts.push("IF NOT EXISTS")
    parts.push(`'${escapeStringLiteral(node.value)}'`)
    if (node.position) {
      parts.push(node.position.kind, `'${escapeStringLiteral(node.position.existing)}'`)
    }
    return parts.join(" ")
  }

  private printAlterTypeRename(node: AlterTypeRenameNode): string {
    // Same feature gate as the other ALTER TYPE forms: PG only.
    assertFeature(this.dialect, "CUSTOM_TYPES")
    if (node.newName === "") {
      // Mirrors the `AlterTypeAddValueNode` empty-value diagnostic —
      // builders seed `newName: ""` and require `.to(...)`. Refuse here
      // rather than emit `RENAME TO ""` (which PG would reject as a
      // bad identifier anyway, with a less helpful message).
      throw new Error(
        `ALTER TYPE "${node.name}" RENAME TO requires a non-empty target name — pass it to alterTypeRename(name, newName) or call .to(...) before compiling.`,
      )
    }
    validateFunctionName(node.name)
    validateFunctionName(node.newName)
    return [
      "ALTER TYPE",
      quoteIdentifier(node.name, this.dialect),
      "RENAME TO",
      quoteIdentifier(node.newName, this.dialect),
    ].join(" ")
  }

  private printAlterTypeRenameValue(node: AlterTypeRenameValueNode): string {
    // Same feature gate — PG only. RENAME VALUE is PG 10+ specifically,
    // but the dialect-level `CUSTOM_TYPES` flag is granular enough for
    // the cross-dialect refusal; older PG versions raise their own
    // syntax error if the server doesn't recognize the form.
    assertFeature(this.dialect, "CUSTOM_TYPES")
    if (node.oldValue === "") {
      // Refuse with a pointer at `.from(...)` rather than emit a
      // literal empty-string label (which PG would treat as a real
      // search target — almost certainly not what the caller meant).
      throw new Error(
        `ALTER TYPE "${node.name}" RENAME VALUE requires a non-empty old value — call .from(...) before compiling.`,
      )
    }
    if (node.newValue === "") {
      throw new Error(
        `ALTER TYPE "${node.name}" RENAME VALUE requires a non-empty new value — call .to(...) before compiling.`,
      )
    }
    validateFunctionName(node.name)
    return [
      "ALTER TYPE",
      quoteIdentifier(node.name, this.dialect),
      "RENAME VALUE",
      `'${escapeStringLiteral(node.oldValue)}'`,
      "TO",
      `'${escapeStringLiteral(node.newValue)}'`,
    ].join(" ")
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
   * Emit `LOCK TABLE [ONLY] <name> [, ...] [IN <mode> MODE] [NOWAIT]`.
   *
   * PG-only — refuses on MySQL / SQLite / MSSQL via the
   * `LOCK_TABLE_STMT` feature gate (MySQL's `LOCK TABLES` is a
   * different statement entirely; MSSQL uses table hints; SQLite has
   * no equivalent).
   *
   * Defensive guards beyond the type system:
   *
   *  - `tables` must be non-empty. The builder constructor seeds at
   *    least one name, but a hand-rolled AST could land here.
   *  - `mode` is type-restricted to the eight PG keywords; the switch
   *    surface guards against `as unknown` smuggling other tokens
   *    into the unquoted SQL slot.
   *
   * The emitted shape always uses the `LOCK TABLE` long form rather
   * than the `LOCK` short form — both are valid PG, but `LOCK TABLE`
   * reads cleaner in audit trails and matches what `pg_dump` emits.
   */
  private printLockTable(node: LockTableNode): string {
    assertFeature(this.dialect, "LOCK_TABLE_STMT")
    if (node.tables.length === 0) {
      throw new Error("LOCK TABLE requires at least one table name.")
    }
    if (node.mode !== undefined) {
      switch (node.mode) {
        case "ACCESS SHARE":
        case "ROW SHARE":
        case "ROW EXCLUSIVE":
        case "SHARE UPDATE EXCLUSIVE":
        case "SHARE":
        case "SHARE ROW EXCLUSIVE":
        case "EXCLUSIVE":
        case "ACCESS EXCLUSIVE":
          break
        default:
          throw new Error(
            `LOCK TABLE: mode must be one of ACCESS SHARE / ROW SHARE / ROW EXCLUSIVE / SHARE UPDATE EXCLUSIVE / SHARE / SHARE ROW EXCLUSIVE / EXCLUSIVE / ACCESS EXCLUSIVE — got "${String(
              (node as { mode: string }).mode,
            )}".`,
          )
      }
    }
    const parts: string[] = ["LOCK TABLE"]
    if (node.only) parts.push("ONLY")
    parts.push(node.tables.map((t) => quoteIdentifier(t, this.dialect)).join(", "))
    if (node.mode !== undefined) {
      parts.push("IN", node.mode, "MODE")
    }
    if (node.noWait) parts.push("NOWAIT")
    return parts.join(" ")
  }

  /**
   * Emit `COPY table [(cols)] FROM STDIN [WITH (...)]` or
   * `COPY { table [(cols)] | (query) } TO STDOUT [WITH (...)]`. PG only —
   * the printer refuses on every non-PG dialect via `COPY_STMT` and
   * surfaces a dialect-native pointer (`LOAD DATA INFILE`, `BULK
   * INSERT`, `.import` / `.export`).
   *
   * Validation:
   *
   *  - `direction === "from"` requires a table and `source === "STDIN"`.
   *    The query form is rejected (PG itself doesn't allow it).
   *  - `direction === "to"` accepts exactly one of `table` / `query`
   *    (mutually exclusive) and requires `source === "STDOUT"`.
   *  - Option strings flow through `escapeStringLiteral` to keep the
   *    `'…'` literal slot tight against injection.
   *
   * Options are emitted in a stable order — `FORMAT, FREEZE, DELIMITER,
   * NULL, HEADER, QUOTE, ESCAPE, ENCODING` — so two builds with the
   * same inputs serialise identically (handy for test snapshots and
   * audit-trail diffs).
   */
  private printCopy(node: CopyNode): string {
    if (this.dialect !== "pg") {
      // Dialect-specific hint at the equivalent surface. The feature
      // gate would phrase this as "COPY is not supported in mysql"
      // which is technically accurate but unhelpful — the engine has
      // an answer to the same question, just under a different name.
      const hint =
        this.dialect === "mysql"
          ? "use LOAD DATA [LOCAL] INFILE for bulk import / SELECT … INTO OUTFILE for bulk export"
          : this.dialect === "sqlite"
            ? "use the sqlite3 CLI's .import / .export commands (not SQL)"
            : "use BULK INSERT for bulk import / bcp for bulk export"
      throw new UnsupportedDialectFeatureError(this.dialect, `COPY (${hint})`)
    }

    if (node.direction !== "from" && node.direction !== "to") {
      throw new Error(
        `COPY: direction must be "from" or "to" — got "${String(
          (node as { direction: string }).direction,
        )}".`,
      )
    }

    // Direction-specific source/destination guards. STDIN/STDOUT are
    // the only legal values; anything else (a hand-rolled AST with a
    // file path or PROGRAM token) bails up front.
    if (node.direction === "from") {
      if (node.source !== "STDIN") {
        throw new Error(
          `COPY FROM: source must be "STDIN" (file paths and PROGRAM are deferred) — got "${String(
            (node as { source: string }).source,
          )}".`,
        )
      }
      if (node.query) {
        throw new Error("COPY FROM does not accept a query — pass a table instead.")
      }
      if (!node.table) {
        throw new Error("COPY FROM requires a table — call copyFrom(table) at the call site.")
      }
    } else {
      if (node.source !== "STDOUT") {
        throw new Error(
          `COPY TO: source must be "STDOUT" (file paths and PROGRAM are deferred) — got "${String(
            (node as { source: string }).source,
          )}".`,
        )
      }
      if (node.table && node.query) {
        throw new Error("COPY TO: table and query are mutually exclusive — set only one.")
      }
      if (!node.table && !node.query) {
        throw new Error(
          "COPY TO requires either a table or a query — call copyTo(table) or .query(select) at the call site.",
        )
      }
      if (node.query && node.table?.columns && node.table.columns.length > 0) {
        // Defensive — `.query()` clears the table side, but a
        // hand-built AST could still set both. PG would reject the
        // statement; surface a clearer message here.
        throw new Error(
          "COPY TO: column list is only valid with the table form, not the query form.",
        )
      }
    }

    const parts: string[] = ["COPY"]

    if (node.direction === "from" || (node.direction === "to" && node.table)) {
      const t = node.table!
      const namePart = quoteIdentifier(t.name, this.dialect)
      if (t.columns && t.columns.length > 0) {
        const cols = t.columns.map((c) => quoteIdentifier(c, this.dialect)).join(", ")
        parts.push(`${namePart} (${cols})`)
      } else {
        parts.push(namePart)
      }
    } else {
      // Query form (only valid for COPY TO). Routes through the
      // configured SELECT printer so plugins/hooks/normalize/optimize
      // all apply to the inner query — same model as CREATE VIEW AS
      // SELECT.
      parts.push(`(${this.renderSelect(node.query!)})`)
    }

    parts.push(node.direction === "from" ? "FROM" : "TO")
    parts.push(node.source)

    if (node.options) {
      const optsSql = this.formatCopyOptions(node)
      if (optsSql.length > 0) {
        parts.push(`WITH (${optsSql.join(", ")})`)
      }
    }

    return parts.join(" ")
  }

  /**
   * Render the `WITH ( option [, ...] )` payload for a {@link CopyNode}.
   * Returns the option fragments only (no parens, no `WITH`) so the
   * caller can decide whether to emit the wrapper. Direction-aware:
   * `FREEZE` is `COPY FROM`-only, `HEADER MATCH` is `COPY FROM`-only.
   */
  private formatCopyOptions(node: CopyNode): string[] {
    const o = node.options!
    const out: string[] = []

    if (o.format !== undefined) {
      switch (o.format) {
        case "TEXT":
        case "CSV":
        case "BINARY":
          // PG accepts the format token bare without quoting; lowercase
          // matches the form PG itself prints in `\copy --help` output
          // and what every COPY example in the docs uses.
          out.push(`FORMAT ${o.format.toLowerCase()}`)
          break
        default:
          throw new Error(
            `COPY: format must be one of TEXT / CSV / BINARY — got "${String(
              (o as { format: string }).format,
            )}".`,
          )
      }
    }

    if (o.freeze) {
      if (node.direction !== "from") {
        throw new Error("COPY: FREEZE is only valid on COPY FROM.")
      }
      out.push("FREEZE")
    }

    if (o.delimiter !== undefined) {
      out.push(`DELIMITER '${escapeStringLiteral(o.delimiter)}'`)
    }

    if (o.nullString !== undefined) {
      out.push(`NULL '${escapeStringLiteral(o.nullString)}'`)
    }

    if (o.header !== undefined) {
      if (o.header === "MATCH") {
        if (node.direction !== "from") {
          throw new Error("COPY: HEADER MATCH is only valid on COPY FROM.")
        }
        out.push("HEADER MATCH")
      } else if (typeof o.header === "boolean") {
        out.push(`HEADER ${o.header ? "true" : "false"}`)
      } else {
        throw new Error(`COPY: header must be a boolean or "MATCH" — got "${String(o.header)}".`)
      }
    }

    if (o.quote !== undefined) {
      out.push(`QUOTE '${escapeStringLiteral(o.quote)}'`)
    }

    if (o.escape !== undefined) {
      out.push(`ESCAPE '${escapeStringLiteral(o.escape)}'`)
    }

    if (o.encoding !== undefined) {
      out.push(`ENCODING '${escapeStringLiteral(o.encoding)}'`)
    }

    return out
  }

  /**
   * Emit `LISTEN <channel>`. PG only; refuses on every other dialect
   * via the `PUBSUB` feature gate. Channel name flows through
   * `validateFunctionName` first (rejecting anything that isn't a plain
   * SQL identifier) and is then quoted via `quoteIdentifier` so mixed
   * case and reserved keywords survive.
   */
  private printListen(node: ListenNode): string {
    assertFeature(this.dialect, "PUBSUB")
    validateFunctionName(node.channel)
    return `LISTEN ${quoteIdentifier(node.channel, this.dialect)}`
  }

  /**
   * Emit `UNLISTEN <channel>` or `UNLISTEN *`. PG only.
   *
   * The wildcard form (`"*"`) drops every current subscription on the
   * session in one statement; everything else is treated as a named
   * channel, gated by `validateFunctionName`, and quoted via
   * `quoteIdentifier`.
   */
  private printUnlisten(node: UnlistenNode): string {
    assertFeature(this.dialect, "PUBSUB")
    if (node.channel === "*") return "UNLISTEN *"
    validateFunctionName(node.channel)
    return `UNLISTEN ${quoteIdentifier(node.channel, this.dialect)}`
  }

  /**
   * Emit `NOTIFY <channel> [, '<payload>']`. PG only.
   *
   * Channel name flows through `validateFunctionName` then
   * `quoteIdentifier`; the optional payload is escaped through
   * `escapeStringLiteral` (which doubles `'` and escapes `\` for the
   * MySQL `BACKSLASH_ESCAPES` defence — irrelevant on PG, but uniform
   * with every other string-literal slot in the printer).
   */
  private printNotify(node: NotifyNode): string {
    assertFeature(this.dialect, "PUBSUB")
    validateFunctionName(node.channel)
    const head = `NOTIFY ${quoteIdentifier(node.channel, this.dialect)}`
    if (node.payload === undefined) return head
    return `${head}, '${escapeStringLiteral(node.payload)}'`
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
   * Emit `ALTER POLICY <name> ON <table>` in either of its two forms:
   *
   *  - Rename: `ALTER POLICY <name> ON <table> RENAME TO <new>`.
   *  - Modify: `ALTER POLICY <name> ON <table>
   *    [TO role[, ...]] [USING (<expr>)] [WITH CHECK (<expr>)]`.
   *
   * The two forms are mutually exclusive — PG itself refuses any
   * modify-clause alongside `RENAME TO`. The printer refuses at print
   * time so a hand-rolled AST can't slip past the builder. PG also
   * requires at least one alterable clause; the printer surfaces a
   * clearer error than PG's "syntax error" when none is set.
   */
  private printAlterPolicy(node: AlterPolicyNode): string {
    assertFeature(this.dialect, "ROW_LEVEL_SECURITY")
    if (!node.table) {
      throw new Error(
        `ALTER POLICY "${node.name}" requires a target table — call .on(table) before compiling.`,
      )
    }
    const hasRename = node.renameTo !== undefined
    const hasRoles = node.roles !== undefined
    const hasUsing = node.using !== undefined
    const hasWithCheck = node.withCheck !== undefined
    const hasModify = hasRoles || hasUsing || hasWithCheck
    if (hasRename && hasModify) {
      throw new Error(
        `ALTER POLICY "${node.name}": RENAME TO and the modify-form clauses ` +
          `(TO / USING / WITH CHECK) are mutually exclusive — set only one form per statement.`,
      )
    }
    if (!hasRename && !hasModify) {
      throw new Error(
        `ALTER POLICY "${node.name}" requires at least one clause — ` +
          `set .renameTo(...), .to(...), .using(...), or .withCheck(...).`,
      )
    }

    const parts: string[] = [
      "ALTER POLICY",
      quoteIdentifier(node.name, this.dialect),
      "ON",
      this.qualifiedName(node.table, node.schema),
    ]

    if (hasRename) {
      parts.push("RENAME TO", quoteIdentifier(node.renameTo!, this.dialect))
      return parts.join(" ")
    }

    if (hasRoles) {
      // Empty array is a builder-side mistake — PG would emit `TO`
      // without role names and reject the statement.
      if (node.roles!.length === 0) {
        throw new Error(
          `ALTER POLICY "${node.name}": .to(...) requires at least one role name — ` +
            `pass undefined (skip the call) to leave roles unchanged.`,
        )
      }
      const rendered = node.roles!.map((r) => this.renderPolicyRole(r))
      parts.push("TO", rendered.join(", "))
    }

    if (hasUsing) {
      parts.push("USING", `(${this.printExpr(node.using!)})`)
    }

    if (hasWithCheck) {
      parts.push("WITH CHECK", `(${this.printExpr(node.withCheck!)})`)
    }

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
