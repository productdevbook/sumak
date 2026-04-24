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

## Results

Compile throughput measured on an Apple M-series laptop, Node 24, vitest 4.1. Numbers drift across machines — treat only the **relative ordering** as signal.

| scenario           | sumak (hz) |   kysely (hz) | drizzle (hz) | sumak vs kysely | sumak vs drizzle |
| ------------------ | ---------: | ------------: | -----------: | --------------: | ---------------: |
| `select-all`       |  1,794,929 |     1,597,645 |       87,529 |       **1.11×** |       **19.40×** |
| `select-where-eq`  |  1,194,919 |       666,188 |       80,344 |       **1.79×** |       **14.87×** |
| `select-where-and` |  1,505,721 |       605,936 |       38,868 |       **2.48×** |       **38.74×** |
| `join-2-tables`    |    478,841 |       284,523 |       52,851 |       **1.68×** |        **9.06×** |
| `insert-values`    |    632,812 |       489,578 |       67,126 |       **1.29×** |        **9.43×** |
| `update-where`     |  1,141,395 |       718,878 |       78,405 |       **1.59×** |       **14.56×** |
| `delete-where`     |    665,789 | **1,024,416** |      150,204 |           0.65× |        **4.43×** |

sumak is the fastest compiler on six of seven scenarios. `delete-where` is the exception: kysely's dedicated delete path wins by ~1.5×, tracked as a known callback-WHERE overhead worth investigating.

Against **drizzle**, sumak is between **9× and 39× faster** across the board — drizzle's template-literal-heavy internal representation costs a lot per call.

### Per-compile wall time

Same numbers, inverted to nanoseconds per compile — useful for sanity-checking whether the compile path is ever going to show up on a trace.

| scenario           |  sumak | kysely | drizzle |
| ------------------ | -----: | -----: | ------: |
| `select-all`       | 557 ns | 626 ns | 11.4 µs |
| `select-where-eq`  | 837 ns | 1.5 µs | 12.4 µs |
| `select-where-and` | 664 ns | 1.7 µs | 25.7 µs |
| `join-2-tables`    | 2.1 µs | 3.5 µs | 18.9 µs |
| `insert-values`    | 1.6 µs | 2.0 µs | 14.9 µs |
| `update-where`     | 876 ns | 1.4 µs | 12.8 µs |
| `delete-where`     | 1.5 µs | 977 ns |  6.7 µs |

Even the slowest sumak scenario (`join-2-tables`, ~2µs) compiles three orders of magnitude below a local Postgres round-trip (~1ms). Compile cost is not where your end-to-end latency lives — but it _is_ what shows up on a Lambda cold start.

## Why compile-time only?

Query builders live or die on the hot path between the TypeScript call and the SQL string. A benchmark that also spins up a real database would measure Postgres plus the network, not the library. On a Lambda cold path or a serverless edge runtime, compile time is the dominant overhead and the right thing to optimise.

The harness is not a substitute for end-to-end performance testing against a real database — it's a regression guard for sumak's compiler. Numbers drift between machines; treat only the **relative** ordering as signal.
