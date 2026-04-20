import type {
  AccessMode,
  BeginNode,
  CommitNode,
  IsolationLevel,
  ReleaseSavepointNode,
  RollbackNode,
  SavepointNode,
  SetTransactionNode,
  SQLiteLockingMode,
} from "../ast/tcl-nodes.ts"

export interface BeginOptions {
  isolation?: IsolationLevel
  readOnly?: boolean
  deferrable?: boolean
  /** MySQL only: START TRANSACTION WITH CONSISTENT SNAPSHOT. */
  consistentSnapshot?: boolean
  /** SQLite only: BEGIN DEFERRED / IMMEDIATE / EXCLUSIVE. */
  locking?: SQLiteLockingMode
}

export interface CommitOptions {
  chain?: boolean
}

export interface SetTransactionOptions {
  isolation?: IsolationLevel
  readOnly?: boolean
}

function access(readOnly?: boolean): AccessMode | undefined {
  return readOnly === true ? "READ ONLY" : readOnly === false ? "READ WRITE" : undefined
}

/**
 * Transaction Control (TCL) namespace.
 *
 * Builds dialect-aware TCL nodes. Run them through `db.compile(node)` to get SQL.
 *
 * ```ts
 * import { tx } from "sumak"
 *
 * db.compile(tx.begin({ isolation: "SERIALIZABLE", readOnly: true }))
 * db.compile(tx.commit())
 * db.compile(tx.rollback())
 * db.compile(tx.savepoint("sp1"))
 * db.compile(tx.rollbackTo("sp1"))
 * db.compile(tx.releaseSavepoint("sp1"))
 * db.compile(tx.setTransaction({ isolation: "READ COMMITTED" }))
 * ```
 */
export const tx = {
  begin(opts: BeginOptions = {}): BeginNode {
    const node: BeginNode = { type: "tcl_begin" }
    if (opts.isolation) node.isolation = opts.isolation
    const acc = access(opts.readOnly)
    if (acc) node.access = acc
    if (opts.deferrable) node.deferrable = true
    if (opts.consistentSnapshot) node.consistentSnapshot = true
    if (opts.locking) node.locking = opts.locking
    return node
  },

  commit(opts: CommitOptions = {}): CommitNode {
    return opts.chain ? { type: "tcl_commit", andChain: true } : { type: "tcl_commit" }
  },

  rollback(opts: CommitOptions = {}): RollbackNode {
    return opts.chain ? { type: "tcl_rollback", andChain: true } : { type: "tcl_rollback" }
  },

  savepoint(name: string): SavepointNode {
    return { type: "tcl_savepoint", name }
  },

  rollbackTo(name: string): RollbackNode {
    return { type: "tcl_rollback", toSavepoint: name }
  },

  releaseSavepoint(name: string): ReleaseSavepointNode {
    return { type: "tcl_release_savepoint", name }
  },

  setTransaction(opts: SetTransactionOptions = {}): SetTransactionNode {
    const node: SetTransactionNode = { type: "tcl_set_transaction" }
    if (opts.isolation) node.isolation = opts.isolation
    const acc = access(opts.readOnly)
    if (acc) node.access = acc
    return node
  },
} as const
