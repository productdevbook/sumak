# sumak

Type-safe SQL query builder with powerful SQL printers. Zero dependencies, tree-shakeable. Pure TypeScript, works everywhere.

> [!IMPORTANT]
> Keep `AGENTS.md` updated with project status.

## Architecture

7-layer pipeline: **Schema → Builder → AST → Plugin/Hook → Normalize (NbE) → Optimize (rewrite rules) → Printer → SQL**

```
User Code
  │
  ├─ sumak({ dialect, tables })     ← DB type auto-inferred
  │
  ├─ db.selectFrom("users")       ← TypedSelectBuilder<DB, "users", O>
  │    .select("id", "name")       ← O narrows to Pick<O, "id"|"name">
  │    .where(typedEq(...))        ← Expression<boolean> enforced
  │    .build()                    ← SelectNode (frozen AST)
  │
  ├─ db.compile(node)             ← Full pipeline:
  │    1. Plugin AST transforms
  │    2. Lifecycle hooks (before)
  │    3. Normalize (NbE)           ← Predicate simplification, constant folding
  │    4. Optimize (rewrite rules)  ← Predicate pushdown, subquery flattening
  │    5. Printer → SQL
  │    6. Plugin query transforms
  │    7. Lifecycle hooks (after)
  │
  └─ { sql, params }              ← Parameterized output
```

## Project Structure

```
src/
  sumak.ts                   # sumak() factory + Sumak<DB> class; routes compile() for AST / DDL / TCL
  index.ts                  # Main API — v0.1 slim re-exports (~88 value / ~146 total named)
  pg.ts                     # Sub-path: sumak/pg
  mssql.ts                  # Sub-path: sumak/mssql
  mysql.ts                  # Sub-path: sumak/mysql
  sqlite.ts                 # Sub-path: sumak/sqlite
  schema.ts                 # Sub-path: sumak/schema
  ns/                       # Namespace barrels (v0.1 API): ast, win, str, num, arr, tx
  errors.ts                 # Custom error classes
  types.ts                  # Shared types (CompiledQuery, SQLDialect, etc.)
  schema/
    types.ts                # ColumnType<S,I,U>, Selectable, Insertable, Updateable
    column.ts               # ColumnBuilder<S,I,U>, 22 column factories (serial, text, etc.)
    table.ts                # defineTable(), InferTable
    type-utils.ts           # Nullable, ResolveColumnType, SelectResult, etc.
    index.ts                # Re-exports
  ast/
    nodes.ts                # ~40 AST node types (discriminated unions, frozen)
    ddl-nodes.ts            # DDL AST (CREATE/ALTER/DROP TABLE, INDEX, VIEW, …)
    tcl-nodes.ts            # TCL AST (BEGIN/COMMIT/ROLLBACK/SAVEPOINT)
    expression.ts           # Untyped expression factories (col, lit, eq, etc.) — now surfaced only via `ast.*`
    typed-expression.ts     # Expression<T> phantom types (typedEq, typedCol, etc.)
    visitor.ts              # ASTVisitor interface + visitNode dispatcher
    transformer.ts          # ASTTransformer base class
  builder/
    select.ts               # SelectBuilder (untyped, immutable)
    insert.ts               # InsertBuilder
    update.ts               # UpdateBuilder
    delete.ts               # DeleteBuilder
    merge.ts                # MergeBuilder
    expression.ts           # Expression builder helpers (val, resetParamCounter)
    raw.ts                  # Raw SQL escape hatch
    typed-select.ts         # TypedSelectBuilder<DB, TB, O>
    typed-insert.ts         # TypedInsertBuilder<DB, TB>
    typed-update.ts         # TypedUpdateBuilder<DB, TB>
    typed-delete.ts         # TypedDeleteBuilder<DB, TB>
    typed-merge.ts          # TypedMergeBuilder<DB, Target, Source>
  printer/
    base.ts                 # BasePrinter — visitor-based SQL generation
    pg.ts                   # PgPrinter ($1 params, double-quote identifiers)
    mssql.ts                # MssqlPrinter (@p0 params, square-bracket identifiers)
    mysql.ts                # MysqlPrinter (? params, backtick identifiers)
    sqlite.ts               # SqlitePrinter (? params, double-quote identifiers)
    ddl.ts                  # DDLPrinter — CREATE/ALTER/DROP → SQL
    tcl.ts                  # TclPrinter — BEGIN/COMMIT/SAVEPOINT → SQL
    formatter.ts            # SQL pretty-printer (keyword-aware)
    document.ts             # Wadler-style document algebra (text/line/nest/group/render) — internal
    types.ts                # Printer, PrinterOptions, PrintMode
  dialect/
    pg.ts                   # pgDialect() factory
    mssql.ts                # mssqlDialect() factory
    mysql.ts                # mysqlDialect() factory
    sqlite.ts               # sqliteDialect() factory
    types.ts                # Dialect interface
  plugin/
    types.ts                # SumakPlugin, ResultContext interfaces
    plugin-manager.ts       # PluginManager — extends ASTWalker, sequential plugin pipeline (internal)
    factories.ts            # Factory fns — softDelete(), audit(), multiTenant(), subjectType(), … (v0.1 public API)
    hooks.ts                # Hookable — lifecycle hooks (query:before/after, result:transform, etc.)
    result-context.ts       # deriveResultContext — source table + column→table map for result plugins
    with-schema.ts          # WithSchemaPlugin — auto schema prefix
    soft-delete.ts          # SoftDeletePlugin — auto WHERE deleted_at IS NULL
    camel-case.ts           # CamelCasePlugin — snake_case → camelCase results
    subject-type.ts         # SubjectTypePlugin — stamps __typename on result rows (CASL / authz)
    audit-timestamp.ts      # AuditTimestampPlugin — created_at / updated_at injection
    multi-tenant.ts         # MultiTenantPlugin — tenant_id isolation across DML + MERGE
    data-masking.ts         # DataMaskingPlugin — transformResult row redaction
    optimistic-lock.ts      # OptimisticLockPlugin — version column guard
    query-limit.ts          # QueryLimitPlugin — hard row cap
  driver/
    types.ts                # Driver interface (query/execute/transaction/close), Row, ExecuteResult
    execute.ts              # runQuery/runOne/runFirst/runExecute — wires builders to driver
    transaction.ts          # runInTransaction — driver delegation + TCL fallback
  migrate/
    diff.ts                 # diffSchemas — DDL steps from before/after, topologically sorted
    runner.ts               # planMigration / applyMigration / runPlan — with transaction wrapping
  introspect/
    types.ts                # IntrospectedSchema / Table / Column
    pg.ts / mysql.ts        # per-dialect catalog queries
    sqlite.ts / mssql.ts
    generate.ts             # generateSchemaCode — emits sumak TS from introspected schema
    index.ts                # introspect(driver, dialect) dispatcher
  normalize/
    types.ts                # CNF type, NormalizeOptions
    expression.ts           # NbE: normalizeExpression, toCNF, fromCNF
    query.ts                # normalizeQuery — applies NbE to all query types
    index.ts                # Re-exports
  optimize/
    types.ts                # RewriteRule interface, OptimizeOptions
    rules.ts                # Built-in rules: predicate pushdown, subquery flattening
    optimizer.ts            # optimize() — normalize + rewrite rules to fixpoint
    index.ts                # Re-exports
  utils/
    identifier.ts           # Identifier quoting per dialect
    param.ts                # Parameter formatting per dialect
test/
  sumak.test.ts              # Integration: sumak() clean API, plugins, hooks
  ast/                      # node, visitor, transformer, walker, typed-expression
  builder/                  # select, insert, update, delete, merge, expression, compiled, json-optics + typed variants
  driver/                   # execute, transaction (unit tests with mock driver)
  migrate/                  # diff, runner
  introspect/               # pg/mysql/sqlite/mssql catalog readers + generate
  integration/              # pglite-driver + roundtrip tests (plugins, introspect, CTEs, window fns)
  normalize/                # expression, query
  optimize/                 # rules, optimizer
  printer/                  # base, pg, mysql, sqlite, mssql, formatter, document, new-nodes
  dialect/                  # pg, mysql, sqlite, mssql, features
  plugin/                   # plugin-manager, with-schema, soft-delete, camel-case, subject-type, hooks, …
  schema/                   # column, table, type-utils
  parity/                   # cross-dialect parity cases (assertParity helper)
  fuzz/                     # fast-check AST fuzzer
  security/                 # injection / escape-hatch audit
  ddl/ graph/ ns/ helpers/  # additional coverage
  audit{3..24}-regressions.test.ts  # post-release regression pins (to be folded into corpus; task #37)
```

## Public API (v0.1)

~88 named value exports / ~146 total named exports (down from ~208 / ~313 in v0.0.x). Internals (low-level AST factories, visitor, document algebra, printer classes, DDL builder classes, normalize/optimize rule internals, legacy plugin classes, deprecated Col methods) are no longer re-exported. v0.0.12 adds `Driver`, `diffSchemas`/`applyMigration`, `introspect`/`generateSchemaCode`, `subjectType` / `ResultContext`, and `FEATURES` / `assertFeature` to the public surface — strictly additive.

### Setup (single step)

```typescript
import { sumak, pgDialect, serial, text, boolean } from "sumak"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: { id: serial(), name: text().notNull(), active: boolean().defaultTo(true) },
  },
})
```

### Queries

```typescript
db.selectFrom("users").select("id", "name").where(...).compile(db.printer())
db.insertInto("users").values({ name: "Alice" }).returningAll().compile(db.printer())
db.update("users").set({ active: false }).where(...).compile(db.printer())
db.deleteFrom("users").where(...).compile(db.printer())
```

### Transactions

```typescript
import { tx } from "sumak"

db.compile(tx.begin({ isolation: "SERIALIZABLE", readOnly: true }))
db.compile(tx.commit())
db.compile(tx.savepoint("sp1"))
```

### Namespaces

`ast` (low-level AST factories + traversal), `win` (window fns), `str` (string fns), `num` (math fns), `arr` (PG array ops), `tx` (transactions).

### Plugins (factory fns)

```typescript
import { softDelete, audit, multiTenant } from "sumak"

sumak({
  plugins: [
    softDelete({ tables: ["users"] }),
    audit({ tables: ["users"] }),
    multiTenant({ tables: ["users"], tenantId: () => ctx.id }),
  ],
  ...
})
```

### Hooks

```typescript
db.hook("select:before", (ctx) => {
  /* modify AST */
})
db.hook("query:after", (ctx) => {
  /* logging, metrics */
})
db.hook("result:transform", (rows) => {
  /* camelCase */
})
```

### Sub-paths

`sumak`, `sumak/pg`, `sumak/mssql`, `sumak/mysql`, `sumak/sqlite`, `sumak/schema`

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
- **Formatter:** oxfmt (double quotes, no semicolons, sortImports)
- **Linter:** oxlint (unicorn, typescript, oxc plugins)
- **Tests:** vitest in `test/` directory, mirrors `src/` structure
- **Exports:** explicit in `src/index.ts`, no barrel re-exports
- **Commits:** semantic lowercase (`feat:`, `fix:`, `chore:`, `docs:`)
- **Issues:** reference in commits (`feat(#N):`)
- **No code without tests** — every function must have corresponding test coverage
- **AST-first design** — all queries are first built as AST nodes, then printed to SQL
- **Immutable builders** — each builder method returns a new instance
- **Frozen AST nodes** — Object.freeze on all factory outputs
- **Dialect-agnostic core** — printers handle dialect differences, not builders
- **Parameters by default** — never inline user values into SQL strings
- **Type nesting ≤ 5 levels** — keep IDE responsive (tsgo and tsc both have 100-depth limit)

## Testing

- **Framework:** vitest
- **Location:** `test/` directory (mirrors `src/` structure)
- **Coverage:** `@vitest/coverage-v8`
- **Snapshot testing:** SQL output verified with inline assertions
- **Dialect testing:** every query tested against pg, mysql, sqlite printers
- **Type testing:** type-level assertions with `expectTypeOf`
- **Plugin testing:** each plugin tested in isolation and in combination
- **Hook testing:** lifecycle hooks tested with mock handlers
- **No code without tests** — PR must include tests for all new/changed code
- Run all: `pnpm test`
- Run single: `pnpm vitest run test/<path>.test.ts`
- **Current:** 142 test files, 1356 tests, 0 lint errors, 0 tsgo errors
