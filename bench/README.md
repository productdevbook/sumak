# sumak-bench

Compile-time microbenchmark harness: **sumak** vs **drizzle-orm** vs **kysely**.

The harness only measures how long it takes each library to turn a builder expression into `{ sql, params }` — the network round-trip is deliberately excluded so the numbers reflect the library's own overhead rather than whatever Postgres is doing. Query complexity is matched across libraries (same columns, predicates, joins) so the comparison is like-for-like.

Prisma is intentionally **not** included: Prisma is a code-gen + engine layer rather than a pure query builder, so a compile-time comparison would be a category error.

## Run

```bash
pnpm install
pnpm vitest bench --run bench/compile.bench.ts
```

## Scenarios

| name             | shape                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| select-all       | `SELECT * FROM users`                                                                          |
| select-where-eq  | `SELECT id, name FROM users WHERE id = $1`                                                     |
| select-where-and | `SELECT * FROM posts WHERE author_id = $1 AND published > $2`                                  |
| join-2-tables    | `SELECT posts.id, posts.title, users.name FROM posts JOIN users ON posts.author_id = users.id` |
| insert-values    | `INSERT INTO users (id, name, email, created_at) VALUES (...)`                                 |
| update-where     | `UPDATE users SET name = $1 WHERE id = $2`                                                     |
| delete-where     | `DELETE FROM users WHERE id = $1`                                                              |

## Why compile-time only?

Query builders live or die on the hot path between the TypeScript call and the SQL string. A benchmark that also spins up a real database would measure Postgres plus the network, not the library. On a Lambda cold path or a serverless edge runtime, compile time is the dominant overhead and the right thing to optimise.

The harness is not a substitute for end-to-end performance testing against a real database — it's a regression guard for sumak's compiler. Numbers drift between machines; treat only the **relative** ordering as signal.
