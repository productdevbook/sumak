import { bench, describe } from "vitest"

import { scenarios } from "./src/scenarios.ts"

/**
 * Compile-time microbenchmark: for each scenario, time how long each
 * library takes to turn its builder expression into `{ sql, params }`.
 * The network round trip is deliberately excluded — the numbers
 * reflect query-compile overhead only.
 *
 * Run with:
 *   pnpm vitest bench --run
 *   pnpm vitest bench --run --reporter=verbose
 *
 * Prisma is intentionally absent: it's a code-gen + engine layer, so
 * a compile-time comparison with pure query builders would be a
 * category error.
 */
for (const sc of scenarios) {
  describe(sc.name, () => {
    bench("sumak", () => {
      sc.sumak()
    })
    bench("drizzle", () => {
      sc.drizzle()
    })
    bench("kysely", () => {
      sc.kysely()
    })
  })
}
