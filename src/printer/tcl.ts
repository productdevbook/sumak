import type { BeginNode, SetTransactionNode, TclNode } from "../ast/tcl-nodes.ts"
import { UnsupportedDialectFeatureError } from "../errors.ts"
import type { CompiledQuery, SQLDialect } from "../types.ts"
import { quoteIdentifier } from "../utils/identifier.ts"

/**
 * Prints TCL (BEGIN / COMMIT / ROLLBACK / SAVEPOINT) nodes to dialect-specific SQL.
 * Same pattern as DDLPrinter — no params, no expressions; just keyword SQL.
 */
export class TclPrinter {
  private dialect: SQLDialect

  constructor(dialect: SQLDialect) {
    this.dialect = dialect
  }

  print(node: TclNode): CompiledQuery {
    return { sql: this.printNode(node), params: [] }
  }

  private printNode(node: TclNode): string {
    switch (node.type) {
      case "tcl_begin":
        return this.printBegin(node)
      case "tcl_commit":
        return node.andChain ? "COMMIT AND CHAIN" : this.commitKeyword()
      case "tcl_rollback":
        if (node.toSavepoint !== undefined) {
          const name = quoteIdentifier(node.toSavepoint, this.dialect)
          return this.dialect === "mssql"
            ? `ROLLBACK TRANSACTION ${name}`
            : `ROLLBACK TO SAVEPOINT ${name}`
        }
        return node.andChain ? "ROLLBACK AND CHAIN" : this.rollbackKeyword()
      case "tcl_savepoint": {
        const name = quoteIdentifier(node.name, this.dialect)
        return this.dialect === "mssql" ? `SAVE TRANSACTION ${name}` : `SAVEPOINT ${name}`
      }
      case "tcl_release_savepoint": {
        if (this.dialect === "mssql") {
          throw new UnsupportedDialectFeatureError("mssql", "RELEASE SAVEPOINT")
        }
        return `RELEASE SAVEPOINT ${quoteIdentifier(node.name, this.dialect)}`
      }
      case "tcl_set_transaction":
        return this.printSetTransaction(node)
    }
  }

  private printBegin(node: BeginNode): string {
    const parts: string[] = [this.beginKeyword()]

    if (this.dialect === "sqlite" && node.locking) {
      return `BEGIN ${node.locking}`
    }

    if (this.dialect === "pg") {
      if (node.isolation) parts.push(`ISOLATION LEVEL ${node.isolation}`)
      if (node.access) parts.push(node.access)
      if (node.deferrable) parts.push("DEFERRABLE")
      return parts.join(" ")
    }

    if (this.dialect === "mysql") {
      const options: string[] = []
      if (node.consistentSnapshot) options.push("WITH CONSISTENT SNAPSHOT")
      if (node.access) options.push(node.access)
      return options.length > 0 ? `${parts.join(" ")} ${options.join(", ")}` : parts.join(" ")
    }

    return parts.join(" ")
  }

  private printSetTransaction(node: SetTransactionNode): string {
    const parts = ["SET TRANSACTION"]
    if (node.isolation) parts.push(`ISOLATION LEVEL ${node.isolation}`)
    if (node.access) parts.push(node.access)
    return parts.join(" ")
  }

  private beginKeyword(): string {
    switch (this.dialect) {
      case "mysql":
        return "START TRANSACTION"
      case "mssql":
        return "BEGIN TRANSACTION"
      default:
        return "BEGIN"
    }
  }

  private commitKeyword(): string {
    return this.dialect === "mssql" ? "COMMIT TRANSACTION" : "COMMIT"
  }

  private rollbackKeyword(): string {
    return this.dialect === "mssql" ? "ROLLBACK TRANSACTION" : "ROLLBACK"
  }
}
