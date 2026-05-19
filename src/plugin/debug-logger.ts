import type { OnQueryListener, QueryEvent } from "../driver/types.ts"
import type { SumakPlugin, SumakPluginSetupContext } from "./types.ts"

/**
 * Lifecycle phase of a {@link DebugLogEntry}.
 *
 * - `compile` fires from the `query:after` hook the moment sumak finishes
 *   compiling an AST to SQL (always, even when the caller never executes).
 * - `exec-start` / `exec-end` / `exec-error` are derived from the
 *   driver-level `onQuery` events sumak already emits — see
 *   {@link OnQueryListener}.
 */
export type DebugLogPhase = "compile" | "exec-start" | "exec-end" | "exec-error"

/**
 * A single record emitted to the configured {@link DebugLoggerConfig.sink}.
 */
export interface DebugLogEntry {
  readonly phase: DebugLogPhase
  readonly sql: string
  readonly params: readonly unknown[]
  /** Wall-clock duration of the driver call. Populated on `exec-end` / `exec-error`. */
  readonly durationMs?: number
  /** Row count returned by `driver.query` (or affected rows from `execute`). Populated on `exec-end`. */
  readonly rowCount?: number
  /** Thrown value from the driver. Populated on `exec-error`. */
  readonly error?: unknown
  /**
   * `true` when `slowQueryMs` is configured and the `exec-end` event
   * exceeded the threshold. Lets a sink colour or route slow queries
   * differently without re-applying the comparison itself.
   */
  readonly slow?: boolean
}

/**
 * Configuration for {@link debugLogger}.
 */
export interface DebugLoggerConfig {
  /**
   * Destination for log entries. Defaults to a human-readable
   * `console.log` formatter that prints `[PHASE] sql -- params: [...]`,
   * with optional ANSI colour on the phase tag.
   */
  sink?: (entry: DebugLogEntry) => void
  /**
   * Returning `false` skips the entry. Use this to filter out noisy
   * health-check queries (`SELECT 1`, `BEGIN`, …) before they reach the
   * sink. Applied to every phase including `compile`.
   */
  filter?: (entry: DebugLogEntry) => boolean
  /**
   * When set, only `exec-end` events whose `durationMs >= slowQueryMs`
   * are emitted with `phase: "exec-end"` and `slow: true`. Faster
   * queries still emit `exec-start` and `compile` (so you keep a full
   * compile log), but their `exec-end` is suppressed. `exec-error` is
   * always emitted regardless of duration.
   *
   * Leave undefined to log every successful end event.
   */
  slowQueryMs?: number
  /**
   * Colourise the phase tag with ANSI codes in the default sink.
   * Defaults to `process.stdout.isTTY` (detected at plugin construction)
   * so piping output to a file doesn't pollute it with escape codes.
   * Ignored when a custom `sink` is provided.
   */
  color?: boolean
}

const ANSI = {
  reset: "[0m",
  cyan: "[36m",
  green: "[32m",
  yellow: "[33m",
  red: "[31m",
  gray: "[90m",
} as const

const PHASE_COLOR: Record<DebugLogPhase, keyof typeof ANSI> = {
  compile: "cyan",
  "exec-start": "gray",
  "exec-end": "green",
  "exec-error": "red",
}

function detectTty(): boolean {
  // `process` may be absent in browser-ish bundlers; guard accordingly.
  if (typeof process === "undefined") return false
  const stdout = (process as { stdout?: { isTTY?: boolean } }).stdout
  return Boolean(stdout?.isTTY)
}

function paintPhase(phase: DebugLogPhase, useColor: boolean, slow: boolean): string {
  const tag = slow && phase === "exec-end" ? "exec-end (slow)" : phase
  if (!useColor) return `[${tag.toUpperCase()}]`
  const colorKey = slow && phase === "exec-end" ? "yellow" : PHASE_COLOR[phase]
  return `${ANSI[colorKey]}[${tag.toUpperCase()}]${ANSI.reset}`
}

function defaultSink(useColor: boolean): (entry: DebugLogEntry) => void {
  return (entry) => {
    const tag = paintPhase(entry.phase, useColor, entry.slow === true)
    const parts: string[] = [tag, entry.sql]
    if (entry.params.length > 0) {
      parts.push(`-- params: ${JSON.stringify(entry.params)}`)
    }
    if (entry.durationMs !== undefined) {
      parts.push(`(${entry.durationMs.toFixed(2)}ms)`)
    }
    if (entry.rowCount !== undefined) {
      parts.push(`rows=${entry.rowCount}`)
    }
    if (entry.error !== undefined) {
      const msg = entry.error instanceof Error ? entry.error.message : String(entry.error)
      parts.push(`error=${msg}`)
    }
    console.log(parts.join(" "))
  }
}

/**
 * Observer-style plugin that logs every compiled SQL statement (and
 * optionally every executed call) to a user-provided sink. Useful for
 * development workflows where setting up an APM tool is overkill — drop
 * the plugin in, see every query sumak emits.
 *
 * Two streams of events feed the sink:
 *
 * - **compile phase.** Hooks `query:after`, which fires once sumak has
 *   produced a {@link import("../types.ts").CompiledQuery}. Independent of
 *   whether the caller goes on to execute — useful for unit tests that
 *   only call `.toSQL()`.
 * - **execute phase.** Subscribes to the driver-level `onQuery` events
 *   sumak emits around `runQuery` / `runExecute` / `transaction`. The
 *   plugin pushes its listener into the chain via the setup-time
 *   {@link SumakPluginSetupContext.addOnQuery} entry point, so it
 *   coexists with the user's own `config.onQuery` instead of replacing
 *   it.
 *
 * ```ts
 * import { sumak, debugLogger, pgDialect } from "sumak"
 *
 * const db = sumak({
 *   dialect: pgDialect(),
 *   tables,
 *   plugins: [
 *     debugLogger({
 *       filter: (entry) => !entry.sql.startsWith("SELECT 1"),
 *       slowQueryMs: 100,
 *     }),
 *   ],
 * })
 * ```
 */
export class DebugLoggerPlugin implements SumakPlugin {
  readonly name = "debug-logger"
  private readonly sink: (entry: DebugLogEntry) => void
  private readonly filter?: (entry: DebugLogEntry) => boolean
  private readonly slowQueryMs?: number

  constructor(config: DebugLoggerConfig = {}) {
    const useColor = config.color ?? detectTty()
    this.sink = config.sink ?? defaultSink(useColor)
    this.filter = config.filter
    this.slowQueryMs = config.slowQueryMs
  }

  /**
   * Push an entry through the optional filter, then the sink. Sink
   * throws are swallowed to match the observability contract — a
   * logger bug must never take down a query, whether we're feeding the
   * sink from the `query:after` hook (which propagates) or the
   * `onQuery` listener (which already silences throws).
   */
  private emit(entry: DebugLogEntry): void {
    try {
      if (this.filter && !this.filter(entry)) return
      this.sink(entry)
    } catch {
      // Same swallow policy as driver/execute.ts emit().
    }
  }

  /**
   * Build the listener that translates {@link QueryEvent}s into
   * {@link DebugLogEntry}s. Exposed as a method (not inlined into
   * `setup`) so tests can drive it directly without spinning up a full
   * Sumak + driver.
   */
  asOnQueryListener(): OnQueryListener {
    return (event: QueryEvent) => {
      switch (event.phase) {
        case "start": {
          this.emit({ phase: "exec-start", sql: event.sql, params: event.params })
          return
        }
        case "end": {
          const slow = this.slowQueryMs !== undefined && event.durationMs >= this.slowQueryMs
          if (this.slowQueryMs !== undefined && !slow) return
          const rowCount = event.rowCount ?? event.affected
          this.emit({
            phase: "exec-end",
            sql: event.sql,
            params: event.params,
            durationMs: event.durationMs,
            ...(rowCount === undefined ? {} : { rowCount }),
            ...(slow ? { slow: true } : {}),
          })
          return
        }
        case "error": {
          this.emit({
            phase: "exec-error",
            sql: event.sql,
            params: event.params,
            durationMs: event.durationMs,
            error: event.error,
          })
          return
        }
      }
    }
  }

  setup(api: SumakPluginSetupContext): void {
    // Compile phase: fires every time sumak prints an AST to SQL, even
    // when no driver is configured.
    api.hook("query:after", (ctx) => {
      this.emit({
        phase: "compile",
        sql: ctx.query.sql,
        params: ctx.query.params,
      })
      // Returning undefined leaves the compiled query unchanged — the
      // plugin is observer-only.
      return undefined
    })
    // Execute phase: chain alongside the user-provided onQuery
    // listener instead of replacing it.
    api.addOnQuery(this.asOnQueryListener())
  }
}

/**
 * Factory for {@link DebugLoggerPlugin}. Use this in the `plugins`
 * array of `sumak({ ... })`.
 */
export function debugLogger(config: DebugLoggerConfig = {}): SumakPlugin {
  return new DebugLoggerPlugin(config)
}
