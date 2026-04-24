// Nuxt 4 defaults: `app/` directory layout, typed runtime config.
// Server routes live under `server/api/`; the DB singleton is
// imported from `server/utils/` so it stays out of the client bundle.

export default defineNuxtConfig({
  compatibilityDate: "2025-07-01",
  runtimeConfig: {
    // Server-only: DATABASE_URL is read from env at runtime.
    databaseUrl: "",
  },
})
