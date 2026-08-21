import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // pglite's WASM engine has a cold-start cost that's noticeable
    // under full-suite parallel load — a handful of integration tests
    // time out at the 5s default when every pglite-backed file is
    // instantiating at once. 15s is generous enough for the slowest
    // pglite spin-up we've seen on CI (~8s) while still catching
    // genuine hangs.
    testTimeout: 15000,
    // Concurrency cap.
    //
    // ~20 of our tests instantiate their own PGlite WASM engine in
    // `beforeAll`. On the 12-thread default pool, ~12 PGlite spins
    // land simultaneously and contend for the same WASM compiler /
    // file descriptors. The slowest ones blow past `testTimeout` and
    // `pnpm vitest run` goes red even though `--no-file-parallelism`
    // (which serialises by file) passes cleanly. Capping max workers
    // to 4 matches what each PGlite instance can comfortably fit
    // without contending — small enough to be reliable, large enough
    // that unit-test files (which don't touch pglite) still
    // parallelise hard. End-to-end suite time drops from ~24s (flaky)
    // to ~28s (reliable) on a 12-core machine.
    //
    // Top-level `maxWorkers` applies to whichever pool is active
    // (threads or forks). If the suite grows past a few hundred unit
    // files and the cap becomes a bottleneck, split pglite tests into
    // a `projects` config with their own (smaller) limit instead of
    // raising this number — the WASM contention is real.
    maxWorkers: 4,
    minWorkers: 1,
  },
})
