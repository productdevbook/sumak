import { readFileSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import { describe, expect, it } from "vitest"

import { scenarios } from "./src/scenarios.ts"

interface Baseline {
  scenarios: Record<string, { sumakMinHz: number }>
}

/**
 * Performance regression guard — a plain vitest test, not a vitest
 * bench. Reason: vitest 4's bench JSON reporter is fragile; using
 * `performance.now()` + a tight loop inside a test gives us a stable,
 * CI-friendly measurement without the extra tooling.
 *
 * For each scenario, we hot-loop the sumak compile path for a fixed
 * duration (200ms per scenario after 50ms warmup) and compute
 * ops/sec from iteration count. That's enough signal to catch ~2x
 * regressions while staying under the default test timeout.
 *
 * The baseline floors in `bench/baseline.json` are deliberately loose
 * (roughly half of developer-laptop measurements) so slower CI boxes
 * don't produce false alarms. When you genuinely speed something up
 * and want to lock in the gain, raise the floor in that file.
 *
 * The test is skipped by default — set `PERF_GUARD=1` to enable it.
 * On a local dev loop you don't want to burn 1.4s on a benchmark
 * every time you save a file.
 */

const baselinePath = join(process.cwd(), "bench", "baseline.json")
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline

const shouldGuard =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.PERF_GUARD === "1"

const WARMUP_MS = 50
const MEASURE_MS = 200

describe.skipIf(!shouldGuard)("perf regression", () => {
  for (const sc of scenarios) {
    it(`${sc.name} stays at or above ${baseline.scenarios[sc.name]?.sumakMinHz ?? "?"} hz`, () => {
      const floor = baseline.scenarios[sc.name]?.sumakMinHz
      expect(floor, `no baseline entry for ${sc.name}`).toBeDefined()

      // Warmup — give the JIT a chance to optimise the compile path
      // before we start counting.
      const warmupEnd = performance.now() + WARMUP_MS
      while (performance.now() < warmupEnd) sc.sumak()

      const measureStart = performance.now()
      const measureEnd = measureStart + MEASURE_MS
      let iterations = 0
      while (performance.now() < measureEnd) {
        // Burst of iterations between clock reads so the clock
        // overhead doesn't dominate a sub-microsecond compile.
        for (let i = 0; i < 100; i++) sc.sumak()
        iterations += 100
      }
      const elapsedMs = performance.now() - measureStart
      const hz = (iterations / elapsedMs) * 1000

      expect(
        hz,
        `${sc.name} ran at ${Math.round(hz)} hz, below the ${floor} hz baseline (${(hz / floor!).toFixed(2)}x). ` +
          "Either fix the regression or — if deliberate — update bench/baseline.json.",
      ).toBeGreaterThanOrEqual(floor!)
    })
  }
})
