# sumak examples

Minimal integration recipes — not tutorials. Each example is a single directory you can copy into a new project and adapt. They're small on purpose: the point is to show how sumak plugs into a given runtime, not to ship a production app.

| directory                     | stack                          | what it demonstrates                                   |
| ----------------------------- | ------------------------------ | ------------------------------------------------------ |
| [`express/`](./express)       | Express 5 + pg                 | Request-scoped sumak, transactions, streaming response |
| [`fastify/`](./fastify)       | Fastify 5 + pg                 | Plugin registration, schema validation + sumak types   |
| [`aws-lambda/`](./aws-lambda) | AWS Lambda + RDS Data API / pg | Cold-start-safe client reuse, AbortSignal on timeout   |
| [`nextjs/`](./nextjs)         | Next.js 15 App Router + pg     | Server Actions, streaming, per-request tenant scoping  |

## Running locally

Every example expects a Postgres connection via `DATABASE_URL`. The quickest way:

```bash
docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:17
export DATABASE_URL="postgres://postgres:pg@localhost:5432/postgres"
```

Then inside the example directory:

```bash
pnpm install
pnpm dev
```

Each example's README explains the minimal schema it needs and includes a `pnpm migrate` shortcut that uses the sumak CLI to create tables from the shared schema module.

## Why not Prisma-style code generation?

None of these examples require a build step. `import { tables } from "./schema"` gives you the typed query builder directly; no `prisma generate`, no `drizzle-kit` before first run. If you want generated files (e.g. for introspection round-trips), `sumak introspect --out src/schema.generated.ts` handles that — but it's opt-in.
