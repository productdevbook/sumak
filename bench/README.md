# sumak-bench

Compile-time microbenchmark harness: **sumak** vs **drizzle-orm** vs **kysely**.

The harness only measures how long it takes each library to turn a builder expression into `{ sql, params }` — the network round-trip is deliberately excluded so the numbers reflect the library's own overhead rather than whatever Postgres is doing. Query complexity is matched across libraries (same columns, predicates, joins) so the comparison is like-for-like.

Prisma is intentionally **not** included: Prisma is a code-gen + engine layer rather than a pure query builder, so a compile-time comparison would be a category error.

## Run

```bash
pnpm install
pnpm vitest bench --run bench/compile.bench.ts
```

## Smoke test

Before changing or adding a scenario, run the smoke test:

```bash
pnpm vitest run bench/_scenarios.test.ts
```

It snapshots every scenario's compiled SQL across all three libraries and asserts that WHERE-bearing queries actually carry their parameters through. It exists because for >7 months the bench was running with a silent-no-op bug where sumak's typed builder accepted `.where("col", "=", val)` (kysely's three-arg form) at runtime, dropped the operator and value, and produced SQL **without a WHERE clause** — making every WHERE scenario unfairly favorable to sumak. The smoke test would have caught that the moment it landed.

## Scenarios (19 total)

| name                    | shape                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| select-all              | `SELECT * FROM users`                                                |
| select-where-eq         | `SELECT id, name FROM users WHERE id = $1`                           |
| select-where-and        | `SELECT * FROM posts WHERE author_id = $1 AND published > $2`        |
| join-2-tables           | `SELECT … FROM posts JOIN users ON posts.author_id = users.id`       |
| insert-values           | `INSERT INTO users (id, name, email, created_at) VALUES (...)`       |
| update-where            | `UPDATE users SET name = $1 WHERE id = $2`                           |
| delete-where            | `DELETE FROM users WHERE id = $1`                                    |
| select-where-or         | `SELECT id, name FROM users WHERE id = $1 OR name = $2`              |
| select-where-in-small   | `SELECT * FROM users WHERE id IN ($1..$5)`                           |
| select-where-in-large   | `SELECT * FROM users WHERE id IN ($1..$100)`                         |
| select-order-limit      | `SELECT * FROM users ORDER BY name ASC LIMIT 10 OFFSET 20`           |
| select-aggregate        | `SELECT COUNT(*) AS total, MAX(id) AS hi, AVG(id) AS avg FROM users` |
| select-group-having     | `SELECT author_id, COUNT(*) FROM posts GROUP BY author_id HAVING …`  |
| select-distinct         | `SELECT DISTINCT name FROM users`                                    |
| left-join-3-tables      | `SELECT … FROM comments LEFT JOIN posts LEFT JOIN users`             |
| select-subquery-in      | `SELECT * FROM posts WHERE author_id IN (SELECT id FROM users …)`    |
| insert-many-100         | `INSERT INTO users VALUES (…), (…) × 100`                            |
| select-where-deep-and   | 5-clause AND chain on posts                                          |
| select-order-desc-limit | `SELECT * FROM posts ORDER BY published DESC LIMIT 20`               |

## Results (post-`.where()` fix, 2026-05-18)

Compile throughput on an Apple M-series laptop, Node 24, vitest 4.1. Numbers drift across machines — treat the **relative ordering** as the signal, not the absolute hz.

| scenario                  | sumak (hz) | kysely (hz) | drizzle (hz) | sumak vs kysely | sumak vs drizzle |
| ------------------------- | ---------: | ----------: | -----------: | --------------: | ---------------: |
| `select-all`              |    729,186 |     671,765 |       49,520 |       **1.09×** |       **14.72×** |
| `select-where-eq`         |    270,550 | **295,165** |       44,452 |           0.92× |        **6.09×** |
| `select-where-and`        |    164,992 | **259,477** |       22,942 |           0.64× |        **7.19×** |
| `join-2-tables`           |    215,362 |     141,255 |       28,054 |       **1.52×** |        **7.68×** |
| `insert-values`           |    304,936 |     221,208 |       40,223 |       **1.38×** |        **7.58×** |
| `update-where`            |    279,549 | **324,720** |       44,504 |           0.86× |        **6.28×** |
| `delete-where`            |    329,836 | **454,393** |       88,985 |           0.73× |        **3.71×** |
| `select-where-or`         |    192,942 |     145,543 |       31,883 |       **1.33×** |        **6.05×** |
| `select-where-in-small`   |    188,276 |     191,000 |       12,300 |           0.98× |       **15.34×** |
| `select-where-in-large`   |     61,142 |  **77,400** |        1,150 |           0.79× |       **53.02×** |
| `select-order-limit`      |    429,450 |     251,116 |       35,800 |       **1.71×** |       **11.99×** |
| `select-aggregate`        |    211,892 |     157,000 |       40,400 |       **1.35×** |        **5.24×** |
| `select-group-having`     |    179,372 |     141,200 |       33,700 |       **1.27×** |        **5.32×** |
| `select-distinct`         |    508,317 |     406,700 |       80,900 |       **1.25×** |        **6.28×** |
| `left-join-3-tables`      |    130,461 |      98,800 |       20,900 |       **1.32×** |        **6.25×** |
| `select-subquery-in`      |    179,720 |     182,000 |       17,300 |           0.99× |       **10.40×** |
| `insert-many-100`         |     11,774 |       8,011 |          608 |       **1.47×** |       **19.36×** |
| `select-where-deep-and`   |     76,021 | **139,950** |       15,600 |           0.54× |        **4.87×** |
| `select-order-desc-limit` |    373,047 |     298,050 |       30,700 |       **1.25×** |       **12.15×** |

**Where sumak wins (11 of 19):** `select-all`, `join-2-tables`, `insert-values`, `select-where-or`, `select-order-limit`, `select-aggregate`, `select-group-having`, `select-distinct`, `left-join-3-tables`, `insert-many-100`, `select-order-desc-limit`.

**Where kysely wins (8 of 19):** the simple WHERE-`=`, WHERE-`AND`, and large-IN scenarios. Kysely has a very tight WHERE compile path; sumak's `select-where-in-large` (100-value IN) gap closed from 3.66× to 1.27× after the `Col.in()` build path was rewritten and the normalize/optimize passes were taught to fast-path leaf-param IN lists. Further closing the gap likely requires a dedicated `ParamArrayNode` AST type so the visitor / fingerprint passes can skip per-value dispatch entirely.

Against **drizzle**, sumak is **4.87×–47× faster** across the board — drizzle's template-literal-heavy internal representation costs a lot per call.

### What changed in this baseline

Re-baselined on 2026-05-18 after fixing a silent-no-op bug where sumak's typed builder was accepting kysely-style `.where("col", "=", val)` at runtime and **dropping the predicate** — every WHERE-bearing scenario was generating sumak SQL without a WHERE clause. Pre-fix numbers had sumak winning every WHERE scenario by 1.5–3.5×, but it was comparing `SELECT * FROM users` to the competitors' parameterized `SELECT … WHERE id = $1`.

The fix is a runtime guard (`unwrapPredicate` in `src/ast/typed-expression.ts`) — `.where("col", "=", 1)` now throws a `TypeError` pointing at the callback form. The bench scenarios were rewritten to use the callback form `.where(({col}) => col.eq(1))`, and a snapshot smoke test (`bench/_scenarios.test.ts`) was added so the same silent-divergence can't happen again.

## Per-compile wall time

Same numbers, inverted to nanoseconds per compile — useful for sanity-checking whether the compile path is ever going to show up on a trace.

| scenario                |   sumak | kysely |   drizzle |
| ----------------------- | ------: | -----: | --------: |
| `select-all`            |  1.4 µs | 1.5 µs |   20.2 µs |
| `select-where-eq`       |  3.7 µs | 3.4 µs |   22.5 µs |
| `join-2-tables`         |  4.6 µs | 7.1 µs |   35.6 µs |
| `select-where-in-large` | 16.4 µs | 12.9 µs | 869.4 µs |

Even the slowest sumak scenario (`select-where-in-large`, ~28µs) compiles two orders of magnitude below a local Postgres round-trip (~1ms). Compile cost is not where your end-to-end latency lives — but it _is_ what shows up on a Lambda cold start.

## Why compile-time only?

Query builders live or die on the hot path between the TypeScript call and the SQL string. A benchmark that also spins up a real database would measure Postgres plus the network, not the library. On a Lambda cold path or a serverless edge runtime, compile time is the dominant overhead and the right thing to optimise.

The harness is not a substitute for end-to-end performance testing against a real database — it's a regression guard for sumak's compiler. Numbers drift between machines; treat only the **relative** ordering as signal.
