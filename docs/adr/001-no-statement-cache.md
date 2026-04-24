# ADR 001: No statement cache

**Status:** Accepted · 2026-04-24

## Context

Task #39 proposed an AST-signature-keyed statement cache — the idea being that if the same query shape is compiled twice (same AST structure, different parameter values), we could skip the normalize/optimize/print pipeline on the second call and just re-bind parameters to a cached SQL string. Deferred originally until the benchmark harness (#32) landed, so the decision could rest on measurements rather than intuition.

## Decision

Don't ship a statement cache.

## Rationale

### 1. The cache misses where it matters

A useful cache would need to be keyed on the _parameter-stripped_ AST signature, so that `WHERE id = 42` and `WHERE id = 99` share a hit. Computing that signature is an AST walk that visits every node, collects paths to every `param` node, and builds a stable string key. An AST walk is _exactly_ what `printer.print(ast)` already does. Measurements from `bench/compile.bench.ts`:

| scenario         | sumak hz  | per-compile |
| ---------------- | --------- | ----------- |
| select-all       | 1,740,567 | 0.57 µs     |
| select-where-eq  | 1,220,094 | 0.82 µs     |
| select-where-and | 1,613,820 | 0.62 µs     |
| join-2-tables    | 489,966   | 2.04 µs     |
| insert-values    | 720,673   | 1.39 µs     |
| update-where     | 1,260,505 | 0.79 µs     |
| delete-where     | 766,904   | 1.30 µs     |

The compile cost is already in the **sub-microsecond to single-digit-microsecond** range. Adding a hash computation before the cache lookup would cost roughly the same as the current print (both are AST walks). A hit saves one walk; a miss costs two. Unless the hit rate is well above 50% in real workloads, the cache is a net loss — and in the common case of a prepared builder expression being evaluated once per request, the hit rate is zero.

### 2. I/O dominates anyway

A local Postgres query round-trips in ~0.3ms (pglite) to ~1ms (unix socket) to ~2–10ms (TCP + parse/plan/execute). The compile cost is already three to five orders of magnitude below the network time. Shaving another 0.5µs off the hot path doesn't move the dial on anything a user can measure.

### 3. The driver already does this

pg, mysql2, and mssql all support server-side prepared statements. The cache that actually matters — the one in the database engine — is already there. Adding a client-side cache on top of that duplicates the mechanism and adds its own invalidation problems (plugin state, AST identity, plan staleness).

### 4. Invalidation is a correctness risk

Plugin `transformNode` hooks may depend on external state (tenant id, userId, feature flags, clock). A naive structural cache would produce stale SQL when any of those change. The escape hatches — "invalidate on plugin state change", "expose a cache-key function per plugin" — push the complexity onto plugin authors and turn a zero-config library into a configured one.

### 5. Prepared statements are the right abstraction, if needed later

If a specific workload _is_ compile-bound (e.g. someone codegen-ing thousands of similar queries per request), the right answer is an explicit `prepare()` API that returns a reusable `PreparedQuery` with named parameter slots — the SQL is compiled once at `.prepare()` time, parameter binding is cheap from then on, and invalidation is the caller's problem (they control the lifetime). This is a **larger** design decision (named parameters, new AST node kind, driver adapter changes) and deserves its own ADR when the need is clearly demonstrated.

## Consequences

- `SumakConfig` stays minimal — no `statementCache: true` flag, no LRU size tuning.
- No per-plugin `cacheKey()` contract.
- The benchmark guard (`PERF_GUARD=1`) locks in current compile throughput; any future regression that makes a cache necessary will trip the floor and demand its own rationale.
- If the calculus changes — e.g. a future workload proves compile-bound — reopen this decision. Don't smuggle a cache in under a different name.
