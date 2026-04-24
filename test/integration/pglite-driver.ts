import type { PGlite } from "@electric-sql/pglite"

import type { Driver } from "../../src/driver/types.ts"

/**
 * Minimal PGlite → sumak Driver shim. Used only in tests so we can
 * exercise `driver.query` / `driver.execute` end-to-end without pulling
 * `pg` or a real Postgres into the dev loop.
 *
 * PGlite returns rows with typed fields (strings, numbers, booleans,
 * dates, JSON…) already unpacked, which matches what
 * {@link Driver.query} expects. Params use `$1`-style placeholders, so
 * the pg dialect's printer output plugs straight in.
 */
export function pgliteDriver(pg: PGlite): Driver {
  return {
    async query(sql, params, options) {
      if (options?.signal?.aborted) {
        const err = new Error("The operation was aborted.")
        err.name = "AbortError"
        throw err
      }
      const r = await pg.query<Record<string, unknown>>(sql, [...params])
      return r.rows
    },
    async execute(sql, params, options) {
      if (options?.signal?.aborted) {
        const err = new Error("The operation was aborted.")
        err.name = "AbortError"
        throw err
      }
      const r = await pg.query(sql, [...params])
      return { affected: r.affectedRows ?? 0 }
    },
    // pglite runs in-process and has no server-side cursor; the
    // "stream" here is just query()-into-async-iter. Still useful for
    // testing the builder-side streaming contract — real adapters
    // (pg-query-stream etc.) plug in the same shape.
    async *stream(sql, params, options) {
      if (options?.signal?.aborted) {
        const err = new Error("The operation was aborted.")
        err.name = "AbortError"
        throw err
      }
      const r = await pg.query<Record<string, unknown>>(sql, [...params])
      for (const row of r.rows) {
        if (options?.signal?.aborted) {
          const err = new Error("The operation was aborted.")
          err.name = "AbortError"
          throw err
        }
        yield row
      }
    },
  }
}
