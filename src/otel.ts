// ═══════════════════════════════════════════════════════════════════════════
//  sumak/otel — OpenTelemetry bridge
//
//  Turns `SumakConfig.onQuery` events into OTel spans. No peer dependency
//  on `@opentelemetry/api` at build time; callers pass a `Tracer` at
//  install time. The trace module's public API is narrow (getSpanContext,
//  startSpan, end) so the structural shim here stays small and honest.
// ═══════════════════════════════════════════════════════════════════════════

import type { OnQueryListener, QueryEvent, QueryEventKind } from "./driver/types.ts"

/**
 * Structural shim for the subset of `@opentelemetry/api` that sumak
 * speaks to. Drop in the real `@opentelemetry/api`'s `Tracer` and it
 * just works — this interface is the common subset.
 */
export interface OtelTracer {
  startSpan(name: string, options?: OtelSpanOptions): OtelSpan
}

export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void
  setStatus(status: { code: OtelSpanStatusCode; message?: string }): void
  recordException(error: unknown): void
  end(endTime?: number): void
}

export interface OtelSpanOptions {
  kind?: OtelSpanKind
  attributes?: Record<string, string | number | boolean>
  startTime?: number
}

/**
 * Mirrors `@opentelemetry/api`'s `SpanKind` enum values. The real enum
 * resolves to numbers 0..4; we inline the values so callers who pass
 * a real tracer get matching kinds, and callers who supply a hand-
 * rolled mock can choose whether to consume them.
 */
export const OtelSpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
} as const
export type OtelSpanKind = (typeof OtelSpanKind)[keyof typeof OtelSpanKind]

export const OtelSpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const
export type OtelSpanStatusCode = (typeof OtelSpanStatusCode)[keyof typeof OtelSpanStatusCode]

export interface InstrumentOptions {
  readonly tracer: OtelTracer
  /**
   * `db.system` attribute value — used to tag the span with the
   * database family. Semantic-convention values: `postgresql`,
   * `mysql`, `sqlite`, `mssql`.
   */
  readonly dbSystem?: "postgresql" | "mysql" | "sqlite" | "mssql" | string
  /**
   * `db.name` attribute — schema / database name. Optional, no
   * default.
   */
  readonly dbName?: string
  /**
   * Override the span name. Default: `"{operation} {dbSystem}"`
   * (e.g. `"SELECT postgresql"`), falling back to just the kind
   * when neither can be derived.
   */
  readonly spanName?: (event: QueryEvent) => string
  /**
   * Whether to record the full SQL on the span. Off by default —
   * SQL often contains sensitive values when params aren't properly
   * extracted. Turn on for debugging / local dev.
   */
  readonly includeSql?: boolean
}

/**
 * Wire sumak's onQuery events into an OpenTelemetry tracer. Returns a
 * listener you can hand to `SumakConfig.onQuery` — or a composite
 * wrapper, if you already have one:
 *
 * ```ts
 * import { trace } from "@opentelemetry/api"
 * import { sumak } from "sumak"
 * import { createOtelListener } from "sumak/otel"
 *
 * const tracer = trace.getTracer("myapp")
 * const onQuery = createOtelListener({ tracer, dbSystem: "postgresql" })
 *
 * const db = sumak({ dialect: pgDialect(), driver, tables, onQuery })
 * ```
 *
 * For composition with an existing logger, use
 * {@link combineListeners}.
 */
export function createOtelListener(options: InstrumentOptions): OnQueryListener {
  const { tracer, dbSystem, dbName, spanName, includeSql = false } = options
  // Correlation id (from QueryEvent.id) → live span. We end the span
  // on the matching end / error event. A small Map is plenty — at
  // most a few hundred in-flight queries per instance.
  const inFlight = new Map<number, OtelSpan>()

  return (event: QueryEvent): void => {
    if (event.phase === "start") {
      const op = operationOf(event)
      const name = spanName ? spanName(event) : defaultSpanName(op, dbSystem, event.kind)
      const attributes: Record<string, string | number | boolean> = {
        "db.sumak.kind": event.kind,
      }
      if (dbSystem) attributes["db.system"] = dbSystem
      if (dbName) attributes["db.name"] = dbName
      if (op) attributes["db.operation"] = op
      if (includeSql) attributes["db.statement"] = event.sql
      if (event.txPhase) attributes["db.sumak.tx_phase"] = event.txPhase
      const span = tracer.startSpan(name, {
        kind: OtelSpanKind.CLIENT,
        attributes,
      })
      inFlight.set(event.id, span)
      return
    }

    const span = inFlight.get(event.id)
    if (!span) return // Missed start — nothing we can correlate to.
    inFlight.delete(event.id)

    if (event.phase === "end") {
      if (event.rowCount !== undefined) {
        span.setAttribute("db.sumak.row_count", event.rowCount)
      }
      if (event.affected !== undefined) {
        span.setAttribute("db.sumak.affected", event.affected)
      }
      span.setStatus({ code: OtelSpanStatusCode.OK })
      span.end()
      return
    }

    // phase === "error"
    span.recordException(event.error)
    span.setStatus({
      code: OtelSpanStatusCode.ERROR,
      message: event.error instanceof Error ? event.error.message : String(event.error),
    })
    span.end()
  }
}

/**
 * Compose multiple onQuery listeners into one. Each listener is called
 * in order; errors from individual listeners are swallowed (the
 * contract of `OnQueryListener`).
 */
export function combineListeners(...listeners: OnQueryListener[]): OnQueryListener {
  return (event) => {
    for (const l of listeners) {
      try {
        l(event)
      } catch {
        // Swallow — same policy as sumak's own emit.
      }
    }
  }
}

/**
 * Extract the DML operation name from a QueryEvent — `SELECT`,
 * `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `BEGIN`, `COMMIT`, `ROLLBACK`.
 * Falls back to `undefined` when the statement doesn't start with a
 * recognised keyword (ad-hoc DDL, raw exec).
 */
export function operationOf(event: QueryEvent): string | undefined {
  if (event.kind === "transaction") {
    return event.txPhase ? event.txPhase.toUpperCase() : undefined
  }
  const m = /^\s*([A-Z]+)/i.exec(event.sql)
  if (!m) return undefined
  const op = m[1]!.toUpperCase()
  // Filter down to statements we've actually seen in the wild; avoid
  // tagging spans with random leading keywords from templated SQL.
  const known = new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "VALUES",
    "WITH",
    "EXPLAIN",
  ])
  return known.has(op) ? op : undefined
}

function defaultSpanName(
  op: string | undefined,
  dbSystem: string | undefined,
  kind: QueryEventKind,
): string {
  if (op && dbSystem) return `${op} ${dbSystem}`
  if (op) return op
  if (dbSystem) return `${kind} ${dbSystem}`
  return kind
}
