# sumak + Next.js 15

Next.js App Router + Server Components + Server Actions with a multi-tenant scope.

## What it shows

- **One `Pool` across HMR.** In Next.js dev, a hot reload blows away the module cache but keeps the Node worker alive. `globalThis.__pgPool` pins the pool across reloads so you don't leak connections every time you save a file. In production (`NODE_ENV === "production"`) this guard is skipped — the module cache is stable.
- **`dbFor(tenantId)` pattern.** Route handlers and server actions pull the tenant from the session, then call `dbFor(tid)` to get a Sumak bound with the `multiTenant({ strict: true })` plugin. Every subsequent query — `select`, `insert`, `update`, `delete` — has the tenant predicate injected. Strict mode also refuses cross-tenant inserts at compile time, so a typo can't leak rows.
- **Server Actions → typed queries.** The form submit handler (`toggleTask`) receives a `FormData`, re-establishes the tenant scope, runs the update, and calls `revalidatePath("/")`. No REST shim, no API route, no client-side query-builder bundling.
- **`import "server-only"`.** The DB module imports `server-only`, which blows up at build time if a client component accidentally imports it. Keeps credentials and pools out of the client bundle.

## Structure

```
src/
  lib/
    schema.ts    — shared table definitions (used by both app and sumak.config)
    db.ts        — Pool + sumak singleton, dbFor() factory, server-only
    auth.ts      — tenant-id stub (replace with your auth)
  app/
    page.tsx     — server component listing tasks
    actions.ts   — server action for the toggle form
```

## Run

```bash
export DATABASE_URL="postgres://postgres:pg@localhost:5432/postgres"
pnpm install
pnpm migrate
pnpm dev
```

Set a `tid` cookie (`tid=1`) in the browser to scope to tenant 1.
