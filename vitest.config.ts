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
  },
})
