import type { ASTNode } from "../ast/nodes.ts"
import { SumakError } from "../errors.ts"
import type { ResultContext } from "../plugin/types.ts"
import type { CompiledQuery } from "../types.ts"
import type {
  Driver,
  DriverCallOptions,
  ExecuteResult,
  OnQueryListener,
  QueryEvent,
  Row,
} from "./types.ts"

/**
 * Minimal surface a builder needs to execute. Lets builders call into
 * their parent `Sumak` without importing the class itself (circular).
 *
 * `transformResult` takes an optional {@link ResultContext} so
 * enricher plugins (issue #90, RLS tagging, masking) can see which
 * query produced the rows. Builders derive the context from the AST
 * they just compiled and pass it through.
 *
 * `onQuery` is the configured observability listener, or `undefined`
 * if none was registered. Builders call into this via the `runQuery`
 * / `runExecute` helpers below, which emit start / end / error
 * events around the driver call.
 */
export interface SumakExecutor {
  driver(): Driver
  driverOrNull(): Driver | undefined
  transformResult(rows: Row[], ctx?: ResultContext): Row[]
  onQuery?(): OnQueryListener | undefined
}

export type { ASTNode }

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
 * Monotonic correlation-id source for {@link QueryEvent.id}. Scoped to
 * the module so every Sumak instance shares a single counter — ids are
 * only ever compared within a single listener's lifetime, so cross-db
 * collisions don't matter.
 */
let nextEventId = 1

/** Allocate a new correlation id for a `start` event. @internal */
export function allocQueryEventId(): number {
  return nextEventId++
}

/**
 * Emit an event to the optional listener, swallowing any error it
 * throws so an observability bug can never take down the caller.
 * Listener is called synchronously — if they need async work they
 * should buffer and flush on their own schedule.
 */
function emit(listener: OnQueryListener | undefined, event: QueryEvent): void {
  if (!listener) return
  try {
    listener(event)
  } catch {
    // Silenced on purpose — see docstring on OnQueryListener.
  }
}

/** Current time in ms with as much precision as the runtime offers. */
function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()
}

/**
 * Wrap a driver call in start / end / error events for the
 * observability listener. Kept internal because the variance (row
 * count vs affected, kind discriminator) is only needed by the helper
 * functions below — external plugins use the hooks system instead.
 */
async function withEvents<T>(
  listener: OnQueryListener | undefined,
  kind: "query" | "execute" | "transaction",
  sql: string,
  params: readonly unknown[],
  run: () => Promise<T>,
  endExtras?: (result: T) => { rowCount?: number; affected?: number },
  txPhase?: "begin" | "commit" | "rollback",
  id?: number,
): Promise<T> {
  const eventId = id ?? allocQueryEventId()
  const start = now()
  emit(listener, { phase: "start", kind, sql, params, id: eventId, txPhase })
  try {
    const result = await run()
    const extras = endExtras ? endExtras(result) : {}
    emit(listener, {
      phase: "end",
      kind,
      sql,
      params,
      id: eventId,
      durationMs: now() - start,
      txPhase,
      ...extras,
    })
    return result
  } catch (error) {
    emit(listener, {
      phase: "error",
      kind,
      sql,
      params,
      id: eventId,
      durationMs: now() - start,
      txPhase,
      error,
    })
    throw error
  }
}

/**
 * Run a compiled query that is expected to return rows (SELECT, or
 * INSERT/UPDATE/DELETE RETURNING), apply row transforms, and return
 * the rows.
 */
export async function runQuery(
  driver: Driver,
  query: CompiledQuery,
  transform: RowTransformer,
  options?: DriverCallOptions,
  listener?: OnQueryListener,
): Promise<Row[]> {
  const rows = await withEvents(
    listener,
    "query",
    query.sql,
    query.params,
    () => driver.query(query.sql, query.params, options),
    (r) => ({ rowCount: r.length }),
  )
  return transform(rows)
}

/** Build a transform closure that forwards a ResultContext to the executor. */
export function resultTransformer(exec: SumakExecutor, ctx?: ResultContext): RowTransformer {
  return (rows: Row[]) => exec.transformResult(rows, ctx)
}

/**
 * Pull the listener off an executor, hiding the optional-method
 * boilerplate. Builders thread this into `runQuery` / `runExecute` so
 * the observability events carry through when a listener is set and
 * stay zero-cost when one isn't.
 */
export function listenerFor(exec: SumakExecutor): OnQueryListener | undefined {
  return exec.onQuery?.()
}

/**
 * Run a compiled query that is not expected to return rows (INSERT /
 * UPDATE / DELETE without RETURNING, DDL, TCL).
 */
export async function runExecute(
  driver: Driver,
  query: CompiledQuery,
  options?: DriverCallOptions,
  listener?: OnQueryListener,
): Promise<ExecuteResult> {
  return withEvents(
    listener,
    "execute",
    query.sql,
    query.params,
    () => driver.execute(query.sql, query.params, options),
    (r) => ({ affected: r.affected }),
  )
}

/**
 * Return the single row expected from a query that must match exactly
 * one record. Used by `.one()`.
 */
export async function runOne(
  driver: Driver,
  query: CompiledQuery,
  transform: RowTransformer,
  options?: DriverCallOptions,
  listener?: OnQueryListener,
): Promise<Row> {
  const rows = await runQuery(driver, query, transform, options, listener)
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
  options?: DriverCallOptions,
  listener?: OnQueryListener,
): Promise<Row | null> {
  const rows = await runQuery(driver, query, transform, options, listener)
  return rows[0] ?? null
}

/**
 * Run a compiled query as a row stream. Delegates to the driver's
 * `stream()` when present; otherwise falls back to buffering via
 * `query()` + yielding one-by-one from memory. The fallback is
 * correct but loses the memory benefit — callers who care about
 * memory on huge results should pair sumak with a driver that
 * implements `stream()` natively.
 *
 * onQuery events: one start, one end (after the iterator drains),
 * or one error (if the driver / transform throws). Early `break` in
 * the consumer still fires the end event with the rows actually
 * yielded so observers see accurate `rowCount`.
 */
export async function* runStream(
  driver: Driver,
  query: CompiledQuery,
  transform: RowTransformer,
  options?: DriverCallOptions,
  listener?: OnQueryListener,
): AsyncIterable<Row> {
  const id = allocQueryEventId()
  const start = perfNow()
  emit(listener, {
    phase: "start",
    kind: "query",
    sql: query.sql,
    params: query.params,
    id,
  })

  let yielded = 0
  let errored = false
  try {
    if (driver.stream) {
      // Native streaming: the driver handles cursor lifecycle. We
      // pass rows through the row transform one by one so a
      // subjectType / masking plugin sees every row regardless of
      // whether it was buffered or streamed.
      for await (const row of driver.stream(query.sql, query.params, options)) {
        const [transformed] = transform([row])
        yielded++
        if (transformed) yield transformed
      }
    } else {
      // Fallback: buffer the result set once, then yield in order.
      // Not a true stream; documented on `.stream()` so callers
      // know to pair sumak with a streaming-capable driver when
      // memory matters.
      const rows = await driver.query(query.sql, query.params, options)
      const transformed = transform(rows)
      for (const row of transformed) {
        yielded++
        yield row
      }
    }
  } catch (error) {
    errored = true
    emit(listener, {
      phase: "error",
      kind: "query",
      sql: query.sql,
      params: query.params,
      id,
      durationMs: perfNow() - start,
      error,
    })
    throw error
  } finally {
    // The finally fires for both natural completion and for early
    // `break` from the consumer — in both cases we want an `end`
    // event so observers see the actual rowCount. An explicit
    // `throw` in the try takes the errored path and skips this.
    if (!errored) {
      emit(listener, {
        phase: "end",
        kind: "query",
        sql: query.sql,
        params: query.params,
        id,
        durationMs: perfNow() - start,
        rowCount: yielded,
      })
    }
  }
}

function perfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()
}

/**
 * Run a function around BEGIN / COMMIT / ROLLBACK events. The
 * transaction runner (see transaction.ts) hands this helper a `beginFn`
 * that actually emits the BEGIN statement, the body, and finally a
 * commit / rollback function — the events are emitted around it here
 * so every driver implementation shares the same observability hooks.
 */
export async function withTransactionEvents<T>(
  listener: OnQueryListener | undefined,
  beginSql: string,
  body: () => Promise<T>,
  onCommit: (id: number) => void,
  onRollback: (id: number) => void,
): Promise<T> {
  const id = allocQueryEventId()
  await withEvents(
    listener,
    "transaction",
    beginSql,
    [],
    () => Promise.resolve(),
    () => ({}),
    "begin",
    id,
  )
  try {
    const result = await body()
    onCommit(id)
    return result
  } catch (err) {
    onRollback(id)
    throw err
  }
}
