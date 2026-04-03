# lale

Type-safe SQL query builder with powerful SQL printers. Zero dependencies, tree-shakeable. Pure TypeScript, works everywhere.

> [!IMPORTANT]
> Keep `AGENTS.md` updated with project status.

## Project Structure

```
src/
  index.ts                  # Main API — all exports
  pg.ts                     # Sub-path: lale/pg
  mysql.ts                  # Sub-path: lale/mysql
  sqlite.ts                 # Sub-path: lale/sqlite
  errors.ts                 # Custom error classes
  env.d.ts                  # Runtime type declarations
  types.ts                  # Shared types and interfaces
  ast/
    nodes.ts                # AST node definitions (Select, Insert, Update, Delete, etc.)
    expression.ts           # Expression nodes (Column, Literal, Binary, Function, etc.)
    visitor.ts              # AST visitor interface
    transformer.ts          # AST transformer base
  builder/
    select.ts               # SELECT query builder
    insert.ts               # INSERT query builder
    update.ts               # UPDATE query builder
    delete.ts               # DELETE query builder
    expression.ts           # Expression builder (WHERE, HAVING, ON)
    join.ts                 # JOIN builder
    cte.ts                  # CTE (WITH) builder
    raw.ts                  # Raw SQL escape hatch
    schema.ts               # Schema definition types
  printer/
    base.ts                 # Base SQL printer (dialect-agnostic)
    pg.ts                   # PostgreSQL printer ($1, $2 params, RETURNING, etc.)
    mysql.ts                # MySQL printer (backticks, ? params, etc.)
    sqlite.ts               # SQLite printer (? params, type affinity, etc.)
    formatter.ts            # SQL pretty-printer / formatter
    types.ts                # Printer types and interfaces
  dialect/
    pg.ts                   # PostgreSQL dialect config
    mysql.ts                # MySQL dialect config
    sqlite.ts               # SQLite dialect config
    types.ts                # Dialect type definitions
  utils/
    identifier.ts           # Identifier quoting utilities
    param.ts                # Parameter binding utilities
test/
  ast/
    nodes.test.ts           # AST node creation tests
    visitor.test.ts         # Visitor pattern tests
    transformer.test.ts     # Transformer tests
  builder/
    select.test.ts          # SELECT builder tests
    insert.test.ts          # INSERT builder tests
    update.test.ts          # UPDATE builder tests
    delete.test.ts          # DELETE builder tests
    expression.test.ts      # Expression builder tests
    join.test.ts            # JOIN builder tests
    cte.test.ts             # CTE builder tests
  printer/
    base.test.ts            # Base printer tests
    pg.test.ts              # PostgreSQL printer tests
    mysql.test.ts           # MySQL printer tests
    sqlite.test.ts          # SQLite printer tests
    formatter.test.ts       # SQL formatter tests
  dialect/
    pg.test.ts              # PostgreSQL dialect tests
    mysql.test.ts           # MySQL dialect tests
    sqlite.test.ts          # SQLite dialect tests
  utils/
    identifier.test.ts      # Identifier quoting tests
    param.test.ts           # Parameter binding tests
```

## Public API

Single entry: `lale` (everything). Sub-paths: `lale/pg`, `lale/mysql`, `lale/sqlite`.

Key functions: `select()`, `insert()`, `update()`, `deleteFrom()`, `raw()`, `sql()`.

Dialect-specific: `pgDialect()`, `mysqlDialect()`, `sqliteDialect()`.

Utilities: `toSQL()`, `formatSQL()`, `identifier()`, `param()`.

## Build & Scripts

```bash
pnpm build          # obuild (rolldown)
pnpm dev            # vitest watch
pnpm lint           # oxlint + oxfmt --check
pnpm lint:fix       # oxlint --fix + oxfmt
pnpm fmt            # oxfmt
pnpm test           # pnpm lint && pnpm typecheck && vitest run
pnpm typecheck      # tsgo --noEmit
pnpm release        # pnpm test && pnpm build && bumpp && npm publish && git push --follow-tags
```

## Code Conventions

- **Pure ESM** — no CJS
- **Zero runtime dependencies** — everything bundled
- **TypeScript strict** — tsgo for typecheck
- **Formatter:** oxfmt (double quotes, semicolons)
- **Linter:** oxlint (unicorn, typescript, oxc plugins)
- **Tests:** vitest in `test/` directory, mirrors `src/` structure
- **Internal files:** prefix with `_` where applicable
- **Exports:** explicit in `src/index.ts`, no barrel re-exports
- **Commits:** semantic lowercase (`feat:`, `fix:`, `chore:`, `docs:`)
- **Issues:** reference in commits (`feat(#N):`)
- **No code without tests** — every function must have corresponding test coverage
- **AST-first design** — all queries are first built as AST nodes, then printed to SQL
- **Immutable builders** — each builder method returns a new instance
- **Dialect-agnostic core** — printers handle dialect differences, not builders

## Testing

- **Framework:** vitest
- **Location:** `test/` directory (mirrors `src/` structure)
- **Coverage:** `@vitest/coverage-v8`
- **Snapshot testing:** SQL output verified with inline snapshots
- **Dialect testing:** every query tested against all 3 dialects (pg, mysql, sqlite)
- **Type testing:** type-level assertions with `expectTypeOf`
- **No code without tests** — PR must include tests for all new/changed code
- Run all: `pnpm test`
- Run single: `pnpm vitest run test/<path>.test.ts`
