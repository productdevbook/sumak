# sumak + Nitro 3

Standalone Nitro server — no Nuxt on top. Same runtime Nuxt uses internally, but you get to write the whole server surface directly: file-system routes, auto-imported utils, typed event handlers, and deploy presets for Node / Deno / Bun / Cloudflare Workers / AWS Lambda / Vercel.

## What it shows

- **`utils/db.ts` is auto-imported everywhere.** Nitro lifts every export under `utils/` into the global scope of route handlers — no `import { db } from "../../utils/db.ts"` noise. The Pool sits on `globalThis.__pgPool` so HMR doesn't duplicate it.
- **`plugins/close-pool.ts` hooks Nitro's `close` event.** Every dev-server reload and every production graceful shutdown triggers `close`; we end the shared Pool there. Without this hook, HMR leaks connections on every save and Postgres eventually refuses new clients.
- **File-system method dispatch.** `events.get.ts` / `events.post.ts` — the suffix drives the HTTP method, no manual `if (event.method === ...)`. Less boilerplate, same types.
- **Transactional sequence counter.** The POST handler reads `MAX(seq)` and inserts the new row inside a single `db.transaction(async tx => ...)` — both statements share a connection, so two concurrent producers can't hand out the same sequence number.
- **Typed query + runtime config.** `useRuntimeConfig().databaseUrl` reads from env at runtime; sumak's `tables` record drives the typed builder; schema lives in `utils/schema.ts` so both route handlers and `sumak migrate` share it.

## Structure

```
nitro.config.ts          — compatibilityDate + runtime config
utils/
  schema.ts              — shared table definitions (auto-imported)
  db.ts                  — Pool + sumak singleton (auto-imported)
plugins/
  close-pool.ts          — ends the Pool on Nitro `close` (HMR + shutdown)
routes/
  api/
    events.get.ts        — list / cursor-paginate
    events.post.ts       — ingest with monotonic seq
```

## Run

```bash
export DATABASE_URL="postgres://postgres:pg@localhost:5432/postgres"
pnpm install
pnpm migrate
pnpm dev
```

```bash
curl -X POST http://localhost:3000/api/events \
  -H 'content-type: application/json' \
  -d '{"source":"checkout","payload":{"orderId":42}}'
curl http://localhost:3000/api/events?limit=10
```

## Deploy

```bash
# Node (default preset)
pnpm build
node .output/server/index.mjs

# Cloudflare Workers
NITRO_PRESET=cloudflare_module pnpm build

# AWS Lambda
NITRO_PRESET=aws-lambda pnpm build
```

Pick the preset that matches your target. sumak's pg driver runs on any of them; on edge runtimes you may want to swap to an HTTP-based driver (e.g. Neon's serverless driver) since long-lived pg connections don't fit the Workers connection model — but that's your call, not sumak's.
