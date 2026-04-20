/**
 * Transaction Control Language (TCL) AST nodes.
 *
 * Covers BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE SAVEPOINT / SET TRANSACTION
 * across pg, mysql, sqlite, mssql. Printed by TclPrinter — same philosophy as DDL:
 * sumak builds the SQL, your driver executes it.
 */

export type IsolationLevel =
  | "READ UNCOMMITTED"
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE"
  | "SNAPSHOT"

export type AccessMode = "READ ONLY" | "READ WRITE"

/** SQLite-only BEGIN locking mode. */
export type SQLiteLockingMode = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"

export interface BeginNode {
  type: "tcl_begin"
  isolation?: IsolationLevel
  access?: AccessMode
  deferrable?: boolean
  /** MySQL only: START TRANSACTION WITH CONSISTENT SNAPSHOT. */
  consistentSnapshot?: boolean
  /** SQLite only. */
  locking?: SQLiteLockingMode
}

export interface CommitNode {
  type: "tcl_commit"
  andChain?: boolean
}

export interface RollbackNode {
  type: "tcl_rollback"
  andChain?: boolean
  /** If present, ROLLBACK TO SAVEPOINT name. */
  toSavepoint?: string
}

export interface SavepointNode {
  type: "tcl_savepoint"
  name: string
}

export interface ReleaseSavepointNode {
  type: "tcl_release_savepoint"
  name: string
}

export interface SetTransactionNode {
  type: "tcl_set_transaction"
  isolation?: IsolationLevel
  access?: AccessMode
}

export type TclNode =
  | BeginNode
  | CommitNode
  | RollbackNode
  | SavepointNode
  | ReleaseSavepointNode
  | SetTransactionNode
