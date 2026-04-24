# sumak + Nuxt 4

Nuxt 4's App Router layout with a multi-tenant API and typed server routes.

## What it shows

- **`server/utils/db.ts` as the canonical DB handle.** Nitro auto-imports everything under `server/utils/`, so route handlers call `dbFor(tid)` without an explicit import. The Pool is cached on `globalThis` so HMR doesn't duplicate it in dev — same trick the Next.js example uses, different framework.
- **`server/plugins/close-pool.ts` releases the Pool on shutdown / HMR.** Without it, every dev-server reload (and every production graceful shutdown) orphans the old module's Pool rather than closing it — Postgres eventually refuses new connections with _too many clients_. The plugin hooks Nitro's `close` event and ends the shared Pool.
- **File-system-routed method handlers.** `tasks.get.ts`, `tasks.post.ts`, `tasks/[id].patch.ts` — Nitro picks the method up from the suffix, no `if (event.method === ...)` boilerplate. Each handler gets a fully typed event.
- **AbortSignal pass-through.** The PATCH handler grabs `event.node.req.signal` and forwards it to sumak's `exec({ signal })` — a client disconnect cancels the UPDATE server-side instead of silently running against nothing.
- **`multiTenant({ strict: true })`.** Every query on `dbFor(tid)` has `WHERE tenantId = $tid` injected, and inserts that try to set a different `tenantId` are rejected at compile time. No way to leak a row across tenants from a typo.
- **`useRuntimeConfig()` for secrets.** `DATABASE_URL` is read at runtime from env, not baked into the bundle.

## Structure

```
nuxt.config.ts       — runtime config exposing DATABASE_URL
app/
  app.vue            — task list + toggle + create
server/
  utils/
    schema.ts        — shared table definitions
    db.ts            — Pool + sumak singleton, dbFor() factory
  plugins/
    close-pool.ts    — ends the Pool on Nitro `close` (HMR + shutdown)
  api/
    tasks.get.ts     — list
    tasks.post.ts    — create
    tasks/[id].patch.ts  — toggle done
```

## Run

```bash
export DATABASE_URL="postgres://postgres:pg@localhost:5432/postgres"
pnpm install
pnpm migrate
pnpm dev
```

Set a `tid` cookie in the browser (`tid=1`) to scope to tenant 1.

## Notes

- Targets **Node 24+**. Nuxt 4 runs on older Node versions but the CLI example uses the `sumak migrate up` command which expects a recent Node.
- `compatibilityDate` pins Nitro's feature surface — bump it when upgrading Nuxt / Nitro to pick up the matching defaults.
