# sumak-bench

Compile-time microbenchmark harness: **sumak** vs **drizzle-orm** vs **kysely**.

The harness only measures how long it takes each library to turn a builder expression into `{ sql, params }` — the network round-trip is deliberately excluded so the numbers reflect the library's own overhead rather than whatever Postgres is doing. Query complexity is matched across libraries (same columns, predicates, joins) so the comparison is like-for-like.

Prisma is intentionally **not** included: Prisma is a code-gen + engine layer rather than a pure query builder, so a compile-time comparison would be a category error.

## Run

```bash
pnpm install
pnpm vitest bench --run bench/compile.bench.ts   # sumak vs kysely vs drizzle
pnpm vitest bench --run bench/prepared.bench.ts  # the two paths within sumak
```

## Smoke test

Before changing or adding a scenario, run the smoke test:

```bash
pnpm vitest run bench/_scenarios.test.ts
```

It snapshots every scenario's compiled SQL across all three libraries and asserts that WHERE-bearing queries actually carry their parameters through. It exists because for >7 months the bench was running with a silent-no-op bug where sumak's typed builder accepted `.where("col", "=", val)` (kysely's three-arg form) at runtime, dropped the operator and value, and produced SQL **without a WHERE clause** — making every WHERE scenario unfairly favorable to sumak. The smoke test would have caught that the moment it landed.

## Scenarios (48 total)

Cross-library compile-throughput benchmarks. The smoke test in
`bench/_scenarios.test.ts` asserts every scenario's SQL is structurally
equivalent across sumak / kysely / drizzle so the bench compares like-for-
like work.

| name                              | shape                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| select-all                        | `SELECT * FROM users`                                                                            |
| select-where-eq                   | `SELECT id, name FROM users WHERE id = $1`                                                       |
| select-where-and                  | `SELECT * FROM posts WHERE author_id = $1 AND published > $2`                                    |
| join-2-tables                     | `SELECT … FROM posts JOIN users ON posts.author_id = users.id`                                   |
| insert-values                     | `INSERT INTO users (id, name, email, created_at) VALUES (...)`                                   |
| update-where                      | `UPDATE users SET name = $1 WHERE id = $2`                                                       |
| delete-where                      | `DELETE FROM users WHERE id = $1`                                                                |
| select-where-or                   | `SELECT id, name FROM users WHERE id = $1 OR name = $2`                                          |
| select-where-in-small             | `SELECT * FROM users WHERE id IN ($1..$5)`                                                       |
| select-where-in-large             | `SELECT * FROM users WHERE id IN ($1..$100)`                                                     |
| select-order-limit                | `SELECT * FROM users ORDER BY name ASC LIMIT 10 OFFSET 20`                                       |
| select-aggregate                  | `SELECT COUNT(*) AS total, MAX(id) AS hi, AVG(id) AS avg FROM users`                             |
| select-group-having               | `SELECT author_id, COUNT(*) FROM posts GROUP BY author_id HAVING …`                              |
| select-distinct                   | `SELECT DISTINCT name FROM users`                                                                |
| left-join-3-tables                | `SELECT … FROM comments LEFT JOIN posts LEFT JOIN users`                                         |
| select-subquery-in                | `SELECT * FROM posts WHERE author_id IN (SELECT id FROM users …)`                                |
| insert-many-100                   | `INSERT INTO users VALUES (…), (…) × 100`                                                        |
| select-where-deep-and             | 5-clause AND chain on posts                                                                      |
| select-order-desc-limit           | `SELECT * FROM posts ORDER BY published DESC LIMIT 20`                                           |
| cte-single                        | `WITH active AS (SELECT id, name FROM users WHERE id > 0) SELECT * FROM users`                   |
| cte-with-join                     | CTE definition + INNER JOIN against the CTE                                                      |
| select-union                      | `SELECT id, name FROM users UNION SELECT id, name FROM users`                                    |
| select-union-all                  | same with `UNION ALL`                                                                            |
| window-row-number                 | `SELECT id, ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY id) FROM posts`                   |
| upsert-do-update                  | `INSERT … ON CONFLICT (email) DO UPDATE SET name = ?`                                            |
| insert-returning                  | `INSERT … RETURNING id, name`                                                                    |
| select-case-when                  | `SELECT id, CASE WHEN published > 0 THEN 'published' ELSE 'draft' END FROM posts`                |
| select-exists-subquery            | `SELECT … FROM users WHERE EXISTS (SELECT … FROM posts WHERE …)`                                 |
| select-count-distinct             | `SELECT COUNT(DISTINCT author_id) FROM posts`                                                    |
| select-window-rank                | `SELECT id, RANK() OVER (PARTITION BY author_id ORDER BY id) FROM posts`                         |
| select-percentile                 | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY published) FROM posts`                       |
| select-named-window               | `SELECT … OVER w, … OVER w FROM posts WINDOW w AS (PARTITION BY … ORDER BY …)`                   |
| select-json-value                 | `SELECT JSON_VALUE(body, '$.name') FROM posts`                                                   |
| select-is-json                    | `SELECT * FROM posts WHERE body IS JSON`                                                         |
| select-count-any-value            | `SELECT author_id, ANY_VALUE(title) FROM posts GROUP BY author_id`                               |
| merge-not-matched-by-source-bench | `MERGE INTO users USING comments … WHEN MATCHED … WHEN NOT MATCHED … WHEN NOT MATCHED BY SOURCE` |
| select-regex-replace              | `SELECT REGEXP_REPLACE(name, '[^a-z]', '', 'g') FROM users`                                      |
| select-extract-month              | `SELECT EXTRACT(MONTH FROM created_at) FROM users`                                               |
| select-date-trunc                 | `SELECT DATE_TRUNC('day', created_at) FROM users`                                                |
| select-stddev-group               | `SELECT author_id, STDDEV(published) FROM posts GROUP BY author_id`                              |
| select-position                   | `SELECT POSITION('@' IN email) FROM users`                                                       |
| select-array-length               | `SELECT array_length(body, 1) FROM posts`                                                        |
| select-power                      | `SELECT POWER(published, 2) FROM posts`                                                          |

The last seven (`select-window-rank` through `merge-not-matched-by-source-bench`)
cover the SQL features added in PRs #142–151: SQL:2003 named WINDOW,
SQL:2003 ordered-set aggregates (`PERCENTILE_CONT`), SQL:2016 `JSON_VALUE`
and `IS JSON`, SQL:2023 `ANY_VALUE`, and the SQL:2008/2023 three-branch
MERGE with `WHEN NOT MATCHED BY SOURCE`. Where competitors lack a first-
class API for the feature (`PERCENTILE_CONT`, named `WINDOW`, `JSON_VALUE`,
`IS JSON`, `ANY_VALUE`, MERGE) they fall back to raw SQL templates —
sumak's typed builder is doing more work, but the AST it builds is more
analyzable downstream (plugins, transformers, audit hooks). The bench
keeps that tradeoff visible.

The trailing seven (`select-regex-replace` through `select-power`) cover
scalar / aggregate function builders shipped after the previous bench
wave (PRs #155, #156, #162, #164, #165, #166): `REGEXP_REPLACE`,
`EXTRACT`, `DATE_TRUNC`, `STDDEV`, `POSITION`-IN, PG `array_length`, and
`POWER`. Each exercises a typed builder where sumak emits a dedicated
AST node (extract-field, position-IN keyword form, inlined pattern /
unit literals) and the competitors fall back to raw template literals.

## The two paths — `bench/prepared.bench.ts`

`compile.bench.ts` above times the whole pipeline, which is what `.toSQL()`
runs on every call. That is the right measurement for a query whose shape
genuinely varies per request, and the wrong one for the shape a request
usually has, where the query was written once and only the values change.
Nothing measured that until this file existed.

| scenario                | `toSQL()` | `toCompiled()` |     |
| ----------------------- | --------: | -------------: | --: |
| `select-all`            |    1438ns |           51ns | 28× |
| `select-where-eq`       |    3291ns |           58ns | 57× |
| `select-where-deep-and` |   10614ns |          148ns | 72× |
| `insert-values`         |    3356ns |           63ns | 53× |
| `update-where`          |    3481ns |           59ns | 59× |

Everything the pipeline does — plugin transforms, hooks, normalize, optimize,
print — happens once, at definition. What is left is filling the parameter
array.

Two things the table does not show. A compiled query's SQL text is fixed, so
`sumak/drivers/pg` sends it as a named prepared statement and the server keeps
the plan: 243µs against 303µs for the same query, measured with `PREPARE` /
`EXECUTE` against pglite. And end to end a single query costs ~330µs either
way, because the compile this removes is ~1% of it — the split pays on a cold
start, under CPU pressure, and through that plan reuse.

## Plugin overhead microbench

`bench/plugin.bench.ts` measures the per-compile cost of each built-in
plugin against a baseline (no plugins). softDelete and multiTenant add
the most (~2.4× over baseline) because they rewrite the SELECT AST;
camelCase and subjectType are nearly free because they only transform
result rows. See PR #112 for the full table.

## Results (2026-08-21)

Compile throughput on a Linux x86-64 laptop, Node 24, vitest 4.1.11, against
**kysely 0.29.5** and **drizzle-orm 1.0.0-rc.4**. Numbers drift across machines and move
with every competitor release — treat the **relative ordering** as the signal, not the
absolute hz, and re-run before quoting them.

| scenario                            | sumak (hz) | kysely (hz) | drizzle (hz) | vs kysely | vs drizzle |
| ----------------------------------- | ---------: | ----------: | -----------: | --------: | ---------: |
| `select-all`                        |    660,217 |     656,148 |       45,980 | **1.01×** | **14.36×** |
| `select-where-eq`                   |    279,757 |     278,645 |       47,893 | **1.00×** |  **5.84×** |
| `select-where-and`                  |    170,452 |     263,903 |       23,967 |     0.65× |  **7.11×** |
| `join-2-tables`                     |    186,977 |     134,592 |       29,156 | **1.39×** |  **6.41×** |
| `insert-values`                     |    296,182 |     220,500 |       53,962 | **1.34×** |  **5.49×** |
| `update-where`                      |    282,835 |     259,077 |       50,258 | **1.09×** |  **5.63×** |
| `delete-where`                      |    328,023 |     433,579 |      106,158 |     0.76× |  **3.09×** |
| `select-where-or`                   |    210,574 |     135,048 |       29,963 | **1.56×** |  **7.03×** |
| `select-where-in-small`             |    246,646 |     274,988 |       29,172 |     0.90× |  **8.45×** |
| `select-where-in-large`             |     64,345 |     123,568 |        6,054 |     0.52× | **10.63×** |
| `select-order-limit`                |    424,463 |     247,101 |       34,937 | **1.72×** | **12.15×** |
| `select-aggregate`                  |    203,936 |     143,441 |       37,733 | **1.42×** |  **5.40×** |
| `select-group-having`               |    193,709 |     106,482 |       34,447 | **1.82×** |  **5.62×** |
| `select-distinct`                   |    480,007 |     399,421 |       75,117 | **1.20×** |  **6.39×** |
| `left-join-3-tables`                |    131,378 |      93,322 |       19,461 | **1.41×** |  **6.75×** |
| `select-subquery-in`                |    222,901 |     169,853 |       18,210 | **1.31×** | **12.24×** |
| `insert-many-100`                   |     11,115 |       8,075 |        1,100 | **1.38×** | **10.11×** |
| `select-where-deep-and`             |     85,901 |     125,828 |       16,083 |     0.68× |  **5.34×** |
| `select-order-desc-limit`           |    365,796 |     215,213 |       28,181 | **1.70×** | **12.98×** |
| `cte-single`                        |    136,143 |     132,844 |       14,774 | **1.02×** |  **9.22×** |
| `select-union`                      |    229,183 |     157,495 |       18,241 | **1.46×** | **12.56×** |
| `select-union-all`                  |    218,287 |     181,116 |       16,918 | **1.21×** | **12.90×** |
| `cte-with-join`                     |    107,613 |      84,624 |       12,543 | **1.27×** |  **8.58×** |
| `select-from-derived`               |    207,222 |     187,390 |       19,840 | **1.11×** | **10.44×** |
| `insert-from-select`                |    283,199 |     115,438 |       29,266 | **2.45×** |  **9.68×** |
| `select-coalesce`                   |    211,628 |     166,711 |       51,431 | **1.27×** |  **4.11×** |
| `select-group-multi-col`            |    205,110 |      94,395 |       23,668 | **2.17×** |  **8.67×** |
| `scalar-subquery-in-select`         |    171,606 |     124,589 |       23,564 | **1.38×** |  **7.28×** |
| `select-exists-subquery`            |    202,500 |     108,088 |       13,823 | **1.87×** | **14.65×** |
| `select-case-when`                  |    137,560 |     109,389 |       42,195 | **1.26×** |  **3.26×** |
| `upsert-do-update`                  |    186,542 |     140,553 |       31,058 | **1.33×** |  **6.01×** |
| `insert-returning`                  |    240,811 |     120,096 |       25,463 | **2.01×** |  **9.46×** |
| `window-row-number`                 |    207,893 |     130,888 |       45,630 | **1.59×** |  **4.56×** |
| `select-count-distinct`             |    302,101 |     205,617 |       64,115 | **1.47×** |  **4.71×** |
| `select-window-rank`                |    193,228 |     130,774 |       44,689 | **1.48×** |  **4.32×** |
| `select-percentile`                 |    265,929 |     313,584 |       70,427 |     0.85× |  **3.78×** |
| `select-named-window`               |    141,633 |     176,590 |       42,127 |     0.80× |  **3.36×** |
| `select-json-value`                 |    266,466 |     322,727 |       70,731 |     0.83× |  **3.77×** |
| `select-is-json`                    |    300,231 |     311,738 |       32,100 |     0.96× |  **9.35×** |
| `select-count-any-value`            |    220,776 |     200,101 |       42,975 | **1.10×** |  **5.14×** |
| `merge-not-matched-by-source-bench` |     88,433 |      92,442 |       40,157 |     0.96× |  **2.20×** |
| `select-regex-replace`              |    202,404 |     301,809 |       65,606 |     0.67× |  **3.09×** |
| `select-extract-month`              |    263,841 |     226,977 |       60,999 | **1.16×** |  **4.33×** |
| `select-date-trunc`                 |    204,112 |     253,261 |       58,342 |     0.81× |  **3.50×** |
| `select-stddev-group`               |    148,696 |     215,998 |       42,889 |     0.69× |  **3.47×** |
| `select-position`                   |    258,278 |     274,363 |       56,976 |     0.94× |  **4.53×** |
| `select-array-length`               |    234,146 |     303,484 |       60,450 |     0.77× |  **3.87×** |
| `select-power`                      |    249,375 |     296,462 |       65,713 |     0.84× |  **3.79×** |

**sumak wins 32 of 48.** The 16 it loses to kysely are listed below with the margin;
against drizzle it is faster everywhere, by 2.20× to 14.65×.

| kysely wins                         |    by |
| ----------------------------------- | ----: |
| `select-where-in-large`             | 1.92× |
| `select-where-and`                  | 1.55× |
| `select-regex-replace`              | 1.49× |
| `select-where-deep-and`             | 1.46× |
| `select-stddev-group`               | 1.45× |
| `delete-where`                      | 1.32× |
| `select-array-length`               | 1.30× |
| `select-named-window`               | 1.25× |
| `select-date-trunc`                 | 1.24× |
| `select-json-value`                 | 1.21× |
| `select-power`                      | 1.19× |
| `select-percentile`                 | 1.18× |
| `select-where-in-small`             | 1.11× |
| `select-position`                   | 1.06× |
| `merge-not-matched-by-source-bench` | 1.05× |
| `select-is-json`                    | 1.04× |

Two groups. The WHERE-chain scenarios (`select-where-and`, `select-where-deep-and`,
`select-where-in-*`, `delete-where`) lose to binary-tree traversal: the visitor and the
printer walk a left-leaning `binary_op` chain where kysely walks a flat list. That is
backlog item A2, a flat n-ary `logical_op` node. The scalar-function scenarios
(`select-power` through `select-is-json`) lose because sumak builds a typed AST node where
the competitors interpolate a raw template — sumak is doing strictly more work, and the
result is analysable downstream. Both are trades, not regressions.

### What changed in this baseline

Re-measured after three fixes and two competitor majors.

`select("posts.id")` used to emit `SELECT "posts.id"` — one identifier naming a column no
table has, which Postgres rejects. `join-2-tables`, `left-join-3-tables` and
`cte-with-join` were therefore benchmarking sumak on SQL that could not run, against
competitors emitting the real thing. Their snapshots recorded the broken output, and the
benchmark sat outside `tsconfig.json`'s `include`, so nothing typechecked it. It is inside
now.

Parameters are no longer deduplicated by value, so a WHERE chain that happens to repeat a
value keeps both predicates. That costs a little in `select-where-and` and
`select-where-deep-and` and buys one SQL text per call site.

drizzle 1.0.0-rc.4 emits differently from 0.45 — every condition parenthesised, unions
wrapped in a subquery — and is faster than the numbers this file used to carry.

## Per-compile wall time

The same numbers inverted to microseconds per compile, which is the form worth comparing
against anything else on a trace.

| scenario                |   sumak |   kysely |  drizzle |
| ----------------------- | ------: | -------: | -------: |
| `select-all`            |  1.5 µs |   1.5 µs |  21.7 µs |
| `select-where-eq`       |  3.6 µs |   3.6 µs |  20.9 µs |
| `join-2-tables`         |  5.3 µs |   7.4 µs |  34.3 µs |
| `select-where-in-large` | 15.5 µs |   8.1 µs | 165.2 µs |
| `insert-many-100`       | 90.0 µs | 123.8 µs | 909.1 µs |

`insert-many-100` is the slowest sumak scenario at 90µs, and it is a hundred-row VALUES
list — not a shape a request issues in a loop.

For scale: a one-row `SELECT … WHERE id = $1` against pglite, in the same process with no
network at all, costs ~328µs end to end. sumak's compile is ~1% of that, and on a real
server behind a socket the share is smaller still. Compile cost is not where end-to-end
latency lives; it is what shows up on a cold start, when a process compiles every query it
will ever run before serving anything.

Worth knowing what does move that 328µs: the same query as a `PREPARE`d statement runs in
243µs. The 60µs a reusable server-side plan saves is twenty times the whole compile, and
it is only reachable if one call site always emits one SQL text — which is why parameters
are never deduplicated by value.

## Why compile-time only?

Query builders live or die on the hot path between the TypeScript call and the SQL string. A benchmark that also spins up a real database would measure Postgres plus the network, not the library. On a Lambda cold path or a serverless edge runtime, compile time is the dominant overhead and the right thing to optimise.

The harness is not a substitute for end-to-end performance testing against a real database — it's a regression guard for sumak's compiler. Numbers drift between machines; treat only the **relative** ordering as signal.
