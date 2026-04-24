# sumak + Express

Minimal Express 5 server: paginated streaming, transactional writes, AbortSignal-aware deletes.

## Shape

- `src/schema.ts` — table definitions (`users`, `posts`)
- `src/db.ts` — single `Pool` + single `sumak()` instance, reused across requests
- `src/server.ts` — three routes exercising query, transaction, streaming, cancellation

## Run

```bash
export DATABASE_URL="postgres://postgres:pg@localhost:5432/postgres"
pnpm install
pnpm migrate     # creates tables via `sumak migrate up`
pnpm dev
```

```bash
curl http://localhost:3000/posts?limit=100
curl -X POST http://localhost:3000/posts \
  -H 'content-type: application/json' \
  -d '{"authorEmail":"ada@x.io","title":"first","body":"hello"}'
```

## Worth noting

- **One sumak per process.** Don't build a fresh `sumak()` per request — the connection pool is what you share, not the query builder. Per-request context (tenant id, audit userId) plugs in via `db.withSchema(...)` or plugin factories; the base instance stays immutable.
- **Streaming NDJSON.** `db.selectFrom(...).stream()` returns an `AsyncIterable` that backs onto pg's server-side cursor. For a 10M-row export you keep a handful of rows in memory at once.
- **AbortSignal on DELETE.** A client drop fires the `close` event on the request; we propagate that to the driver via `{ signal }`, which cancels the query server-side rather than letting it complete against a dead socket.
- **Transactions are RAII.** `db.transaction(async tx => ...)` begins, passes `tx` to the callback, commits on return, rolls back on throw. The `tx` parameter is a bound sumak instance — it has the same API as `db` but with every statement issued on the same connection.
