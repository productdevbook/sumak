// Release the shared pg Pool when Nitro shuts down — including dev-
// server HMR reloads. Without it, each reload orphans the old
// module's Pool rather than closing it, and Postgres eventually
// refuses new connections with "too many clients".
//
// Re-read `globalThis.__pgPool` at close time rather than importing
// from `utils/db.ts` so a stale module graph can't pin the wrong
// reference.
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook("close", async () => {
    const g = globalThis as unknown as { __pgPool?: { end(): Promise<void> } }
    if (g.__pgPool) {
      await g.__pgPool.end()
      g.__pgPool = undefined
    }
  })
})
