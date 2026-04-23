import { SumakError } from "../errors.ts"
import type { CompiledQuery } from "../types.ts"
import type { Driver, ExecuteResult, Row } from "./types.ts"

/**
 * Minimal surface a builder needs to execute. Lets builders call into
 * their parent `Sumak` without importing the class itself (circular).
 */
export interface SumakExecutor {
  driver(): Driver
  driverOrNull(): Driver | undefined
  transformResult(rows: Row[]): Row[]
}

/**
 * Thrown by `.one()` when the query returned zero rows or more than one
 * row. The message tells the caller which it was.
 */
export class UnexpectedRowCountError extends SumakError {
  constructor(expected: "exactly one", actual: number) {
    super(`expected ${expected} row, got ${actual}`)
    this.name = "UnexpectedRowCountError"
  }
}

/**
 * Thrown when a builder asks for execution but the containing `Sumak`
 * instance was constructed without a `driver`. sumak can still build
 * and compile SQL without a driver — `.execute()` et al. need one.
 */
export class MissingDriverError extends SumakError {
  constructor() {
    super(
      "No driver configured. Pass `driver` to `sumak({ dialect, driver, tables })` " +
        "before calling .execute() / .one() / .many() / .first() / .exec().",
    )
    this.name = "MissingDriverError"
  }
}

/**
 * Apply `.transformResult` plugins and hooks to a row set, returning
 * the transformed rows. Kept separate from the driver call so a
 * transactional helper can decide when to apply transforms.
 */
export type RowTransformer = (rows: Row[]) => Row[]

/**
 * Run a compiled query that is expected to return rows (SELECT, or
 * INSERT/UPDATE/DELETE RETURNING), apply row transforms, and return
 * the rows.
 */
export async function runQuery(
  driver: Driver,
  query: CompiledQuery,
  transform: RowTransformer,
): Promise<Row[]> {
  const rows = await driver.query(query.sql, query.params)
  return transform(rows)
}

/**
 * Run a compiled query that is not expected to return rows (INSERT /
 * UPDATE / DELETE without RETURNING, DDL, TCL).
 */
export async function runExecute(driver: Driver, query: CompiledQuery): Promise<ExecuteResult> {
  return driver.execute(query.sql, query.params)
}

/**
 * Return the single row expected from a query that must match exactly
 * one record. Used by `.one()`.
 */
export async function runOne(
  driver: Driver,
  query: CompiledQuery,
  transform: RowTransformer,
): Promise<Row> {
  const rows = await runQuery(driver, query, transform)
  if (rows.length !== 1) {
    throw new UnexpectedRowCountError("exactly one", rows.length)
  }
  return rows[0]!
}

/**
 * Return the first row or `null`. Used by `.first()`.
 */
export async function runFirst(
  driver: Driver,
  query: CompiledQuery,
  transform: RowTransformer,
): Promise<Row | null> {
  const rows = await runQuery(driver, query, transform)
  return rows[0] ?? null
}
