// Standalone Nitro server — no Nuxt layer on top. File-system
// routes under `routes/` and `api/`, auto-imports under `utils/`,
// server-only plugins under `plugins/`. Deploys to Node, Deno,
// Bun, Cloudflare Workers, AWS Lambda, Vercel edge — same code.

export default defineNitroConfig({
  compatibilityDate: "2025-07-01",
  runtimeConfig: {
    databaseUrl: "",
  },
})
