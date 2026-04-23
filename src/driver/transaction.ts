import type { BeginNode, CommitNode, RollbackNode } from "../ast/tcl-nodes.ts"
import { TclPrinter } from "../printer/tcl.ts"
import type { SQLDialect } from "../types.ts"
import type { Driver } from "./types.ts"

/**
 * Options for {@link runInTransaction} / `db.transaction()`.
 *
 * Mirrors the `tx.begin(opts)` shape — what you'd hand to the TCL
 * printer directly — so the same option vocabulary covers both the
 * "emit SQL" and "actually run a transaction" paths.
 */
export interface TransactionOptions {
  isolation?:
    | "READ UNCOMMITTED"
    | "READ COMMITTED"
    | "REPEATABLE READ"
    | "SERIALIZABLE"
    | "SNAPSHOT"
  readOnly?: boolean
  deferrable?: boolean
  consistentSnapshot?: boolean
  locking?: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"
}

/**
 * Run `fn` inside a transaction. Preference order:
 *
 *   1. If the driver provides a `transaction(fn)` method, use it. This
 *      is the safest path: the driver owns how a connection is pinned
 *      to the scope and how BEGIN/COMMIT/ROLLBACK actually fire.
 *      `fn` receives a scoped Driver whose `query`/`execute` calls run
 *      inside the transaction.
 *
 *   2. Otherwise, emit BEGIN / COMMIT / ROLLBACK on the existing driver
 *      via `driver.execute`. This works for many drivers (pg, sqlite,
 *      mysql2 with a single-connection pool) but is NOT safe for any
 *      driver that multiplexes connections per call — `fn` may run on
 *      a different connection than BEGIN did, silently bypassing the
 *      transaction. Drivers that fan out across connections should
 *      implement `transaction()` themselves.
 *
 * Commits on resolve; rolls back on throw (then rethrows).
 */
export async function runInTransaction<T>(
  driver: Driver,
  dialect: SQLDialect,
  fn: (tx: Driver) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  if (driver.transaction) {
    return driver.transaction(fn)
  }
  return manualTransaction(driver, dialect, fn, opts)
}

/**
 * Emit BEGIN / COMMIT / ROLLBACK on the shared driver. Exposed for
 * drivers that want to reuse the sumak TCL pipeline but still own
 * the scoping (e.g. a custom pool wrapper that picks a connection
 * for the whole scope but can't implement `.transaction` directly).
 */
async function manualTransaction<T>(
  driver: Driver,
  dialect: SQLDialect,
  fn: (tx: Driver) => Promise<T>,
  opts: TransactionOptions,
): Promise<T> {
  const printer = new TclPrinter(dialect)
  const beginNode: BeginNode = { type: "tcl_begin" }
  if (opts.isolation) beginNode.isolation = opts.isolation
  if (opts.readOnly !== undefined) beginNode.access = opts.readOnly ? "READ ONLY" : "READ WRITE"
  if (opts.deferrable) beginNode.deferrable = true
  if (opts.consistentSnapshot) beginNode.consistentSnapshot = true
  if (opts.locking) beginNode.locking = opts.locking

  const commitNode: CommitNode = { type: "tcl_commit" }
  const rollbackNode: RollbackNode = { type: "tcl_rollback" }

  const begin = printer.print(beginNode)
  await driver.execute(begin.sql, begin.params)
  try {
    const result = await fn(driver)
    const commit = printer.print(commitNode)
    await driver.execute(commit.sql, commit.params)
    return result
  } catch (err) {
    const rollback = printer.print(rollbackNode)
    try {
      await driver.execute(rollback.sql, rollback.params)
    } catch (rollbackErr) {
      // Surface the original error; attach the rollback failure so
      // observability doesn't lose it. Prefer the user's error — the
      // rollback failure is almost always a downstream consequence.
      ;(err as Error & { rollbackError?: unknown }).rollbackError = rollbackErr
    }
    throw err
  }
}
