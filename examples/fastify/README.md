# sumak + Fastify

Fastify 5 + JSON schema validation + sumak types.

## What it shows

- **Layered validation.** Fastify's body/params schema catches malformed input at the HTTP boundary; sumak's TypeScript types catch bad queries at compile time. The handler gets fully-typed `req.body` / `req.params` that map directly onto `.values({...})` and `.where(...)`.
- **CHECK constraint round-trip.** `priceCents` is declared with `.check("price_cents > 0")` on the column. If someone bypasses Fastify's validation (e.g. a stale client), the database still refuses the insert — defense in depth.
- **Single builder, many handlers.** One `sumak()` lives at module scope; handlers import it directly. No per-request instantiation, no Fastify decorator magic.

## Run

```bash
export DATABASE_URL="postgres://postgres:pg@localhost:5432/postgres"
pnpm install
pnpm migrate
pnpm dev
```

```bash
curl -X POST http://localhost:3000/products \
  -H 'content-type: application/json' \
  -d '{"sku":"widget-42","name":"Widget","priceCents":2500}'
curl http://localhost:3000/products/widget-42
```
