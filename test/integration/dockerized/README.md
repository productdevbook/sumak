# Dockerized integration tests

End-to-end tests against **real** MySQL and MSSQL servers running in docker. The default `pnpm test` run skips them — spinning up containers on every save loop is too slow and too flaky. These exist for:

1. CI workflows that can afford a ~45-second setup.
2. Local verification before a release.
3. Reproducing a bug someone reported against a live database.

## Running

```bash
# 1. Start the servers. MSSQL takes ~30s to boot on first pull; wait
#    until both services show `(healthy)` in docker ps.
docker compose -f test/integration/dockerized/docker-compose.yml up -d

# 2. Install the driver deps. They're NOT in the main devDependencies —
#    they're optional, and the default test suite must work without
#    them (zero-dep stance).
pnpm add -D mysql2 mssql

# 3. Run the suite.
INTEGRATION_DB=1 pnpm vitest run test/integration/dockerized/

# 4. Tear down when done.
docker compose -f test/integration/dockerized/docker-compose.yml down -v
```

## Why not testcontainers-node?

testcontainers is a fine library but it brings 30+ transitive deps and a significant startup cost. For a zero-dep query builder, pulling it in — even as a devDependency — feels out of proportion. `docker compose up -d` is ~15 lines of YAML; the tests pick up on fixed `127.0.0.1` ports and skip themselves when not enabled. That's all the orchestration we need.

## Port choices

- **3307** for MySQL (not the default 3306) so a local dev MySQL doesn't clash.
- **1434** for MSSQL (not the default 1433) for the same reason.

Both bind to `127.0.0.1` explicitly, not `0.0.0.0`, so shared dev machines don't accidentally expose the test databases.

## What's covered

Each dialect gets a small roundtrip test: apply a two-table schema (users + posts with a FK and a UNIQUE), introspect it back, run a SELECT that forces a real plan, then drop. The goal isn't comprehensive coverage — that's what the mocked catalog tests in `test/introspect/` do — but to catch cases where the mock was too forgiving.

If you add a new feature that interacts with dialect-specific catalog quirks (index definitions, CHECK-constraint wrapping, computed columns), consider adding an integration case here alongside the mock test.
