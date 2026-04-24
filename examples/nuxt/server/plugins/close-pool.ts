// Close the shared pg Pool on server shutdown — including the
// Nitro dev-server reloads that fire whenever you save a file.
// Without this hook, HMR leaks connections on every reload (the
// old module's Pool is orphaned, not closed) and Postgres
// eventually refuses new connections with "too many clients".
//
// `globalThis.__pgPool` is set by `server/utils/db.ts`; we re-read
// it here instead of importing so the plugin doesn't pin a stale
// reference when the module graph is re-evaluated.
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook("close", async () => {
    const g = globalThis as unknown as { __pgPool?: { end(): Promise<void> } }
    if (g.__pgPool) {
      await g.__pgPool.end()
      g.__pgPool = undefined
    }
  })
})
