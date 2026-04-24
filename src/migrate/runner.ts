import type { DDLNode } from "../ast/ddl-nodes.ts"
import { SumakError } from "../errors.ts"
import type { Sumak } from "../sumak.ts"
import type { CompiledQuery } from "../types.ts"
import type { DiffOptions, SchemaDef } from "./diff.ts"
import { diffSchemas } from "./diff.ts"

/**
 * A planned migration — the diff output, each DDL node compiled to
 * SQL once so callers can print a dry-run before `apply`.
 */
export interface MigrationPlan {
  /** The raw DDL nodes — useful if a caller wants to run its own printer. */
  readonly nodes: readonly DDLNode[]
  /** Compiled (sql, params) for each node, same order. */
  readonly steps: readonly CompiledQuery[]
  /** True iff the plan contains DROP TABLE / DROP COLUMN / etc. */
  readonly hasDestructiveSteps: boolean
}

/**
 * Summary of a completed `apply()` call.
 */
export interface ApplyResult {
  /** Total number of statements successfully executed. */
  readonly applied: number
  /** SQL of every statement run, in order — useful for logs / audit. */
  readonly statements: readonly string[]
}

/**
 * Options for {@link planMigration} / {@link applyMigration}.
 */
export interface MigrationOptions extends DiffOptions {
  /**
   * When true, wrap the whole migration in a single transaction via
   * `db.transaction()`. Recommended — if any statement fails, everything
   * rolls back. Requires a driver. Defaults to true when a driver is
   * configured, false otherwise.
   */
  transaction?: boolean

  /**
   * When true (default), serialize concurrent `applyMigration` calls
   * via a session-scoped advisory lock so two deploys racing on the
   * same database don't interleave DDL. Implementation per dialect:
   *   - **pg**: `SELECT pg_advisory_lock(hashtext('sumak-migrate'))`
   *     with `pg_advisory_unlock` in finally.
   *   - **mysql**: `SELECT GET_LOCK('sumak-migrate', -1)` + RELEASE.
   *   - **mssql**: `sp_getapplock @Resource = 'sumak-migrate'` + sp_releaseapplock.
   *   - **sqlite**: no-op — SQLite's single-writer lock already
   *     serialises writes at the engine level.
   *
   * Pass `false` to skip the lock (e.g. when the caller owns lock
   * coordination itself — a CI system that gates deploys behind
   * its own mutex).
   */
  lock?: boolean
}

/**
 * Compute a migration plan: run the diff, compile every step to SQL,
 * return both so the caller can preview. No driver calls happen here.
 */
export function planMigration<DB>(
  db: Sumak<DB>,
  before: SchemaDef,
  after: SchemaDef,
  opts: MigrationOptions = {},
): MigrationPlan {
  const nodes = diffSchemas(before, after, opts)
  const steps = nodes.map((n) => db.compileDDL(n))
  const hasDestructiveSteps = nodes.some(
    (n) =>
      n.type === "drop_table" ||
      n.type === "drop_index" ||
      n.type === "drop_view" ||
      n.type === "drop_schema" ||
      n.type === "truncate_table" ||
      (n.type === "alter_table" && n.actions.some((a) => a.kind === "drop_column")),
  )
  return Object.freeze({ nodes, steps, hasDestructiveSteps })
}

/**
 * Apply a migration: plan + execute.
 *
 * Execution happens inside a transaction by default (requires a
 * driver); if the driver or database doesn't support DDL transactions
 * (e.g. MySQL auto-commits most DDL), pass `transaction: false` and
 * handle rollback at the application level.
 */
export async function applyMigration<DB>(
  db: Sumak<DB>,
  before: SchemaDef,
  after: SchemaDef,
  opts: MigrationOptions = {},
): Promise<ApplyResult> {
  const plan = planMigration(db, before, after, opts)
  return runPlan(db, plan, opts)
}

/**
 * Execute an already-computed plan. Exposed separately so callers that
 * want to confirm a destructive plan with the user before running can
 * do so between `planMigration` and `runPlan`.
 */
export async function runPlan<DB>(
  db: Sumak<DB>,
  plan: MigrationPlan,
  opts: MigrationOptions = {},
): Promise<ApplyResult> {
  if (plan.steps.length === 0) {
    return { applied: 0, statements: [] }
  }
  const driver = db.driverOrNull()
  if (!driver) {
    throw new MigrationRequiresDriverError()
  }

  const useLock = opts.lock ?? true

  const run = async (): Promise<ApplyResult> => {
    const useTransaction = opts.transaction ?? true
    if (useTransaction && driver) {
      return db.transaction(async (tx) => executeSteps(tx, plan.steps))
    }
    return executeSteps(db, plan.steps)
  }

  if (!useLock) return run()
  return withMigrationLock(db, run)
}

/**
 * Acquire a dialect-appropriate session advisory lock, run `fn`,
 * release the lock in `finally`. Release on a locked-but-broken
 * session is best-effort — if the lock release fails the session's
 * termination will drop it anyway on all four dialects.
 */
async function withMigrationLock<DB, T>(db: Sumak<DB>, fn: () => Promise<T>): Promise<T> {
  const dialect = db.dialectName()
  const key = "sumak-migrate"
  const acquire = acquireLockSql(dialect, key)
  const release = releaseLockSql(dialect, key)
  if (!acquire) return fn()

  await db.executeCompiledNoRows({ sql: acquire, params: [] })
  try {
    return await fn()
  } finally {
    if (release) {
      try {
        await db.executeCompiledNoRows({ sql: release, params: [] })
      } catch {
        // Lock release is advisory; a broken session will drop it
        // on disconnect. Swallow so the original error (if any)
        // surfaces.
      }
    }
  }
}

function acquireLockSql(dialect: string, key: string): string | undefined {
  switch (dialect) {
    case "pg":
      return `SELECT pg_advisory_lock(hashtext(${escapeSqlString(key)}))`
    case "mysql":
      return `SELECT GET_LOCK(${escapeSqlString(key)}, -1)`
    case "mssql":
      return `BEGIN EXEC sp_getapplock @Resource = ${escapeSqlString(key)}, @LockMode = 'Exclusive', @LockOwner = 'Session' END`
    case "sqlite":
      // SQLite serialises writes at the engine level already — a
      // second writer waits on a file-level lock. No app-level
      // advisory primitive needed.
      return undefined
    default:
      return undefined
  }
}

function releaseLockSql(dialect: string, key: string): string | undefined {
  switch (dialect) {
    case "pg":
      return `SELECT pg_advisory_unlock(hashtext(${escapeSqlString(key)}))`
    case "mysql":
      return `SELECT RELEASE_LOCK(${escapeSqlString(key)})`
    case "mssql":
      return `BEGIN EXEC sp_releaseapplock @Resource = ${escapeSqlString(key)}, @LockOwner = 'Session' END`
    default:
      return undefined
  }
}

function escapeSqlString(s: string): string {
  // Minimal single-quote escape — the key is a compile-time literal
  // so this is defense in depth, not user-input sanitisation.
  return `'${s.replace(/'/g, "''")}'`
}

async function executeSteps<DB>(
  db: Sumak<DB>,
  steps: readonly CompiledQuery[],
): Promise<ApplyResult> {
  const statements: string[] = []
  for (const step of steps) {
    await db.executeCompiledNoRows(step)
    statements.push(step.sql)
  }
  return { applied: steps.length, statements }
}

/**
 * Thrown when a migration is requested but the sumak instance has no
 * driver. The schema-diff side (`planMigration` / `diffSchemas`) still
 * works driverless — only `applyMigration` / `runPlan` needs it.
 */
export class MigrationRequiresDriverError extends SumakError {
  constructor() {
    super(
      "applyMigration needs a driver — pass `driver` to `sumak({ … , driver })`. " +
        "Planning (planMigration / diffSchemas) still works without one.",
    )
    this.name = "MigrationRequiresDriverError"
  }
}
