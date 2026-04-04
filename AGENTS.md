# sumak

Type-safe SQL query builder with powerful SQL printers. Zero dependencies, tree-shakeable. Pure TypeScript, works everywhere.

> [!IMPORTANT]
> Keep `AGENTS.md` updated with project status.

## Architecture

5-layer pipeline: **Schema → Builder → AST → Plugin/Hook → Printer → SQL**

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
  ├─ db.compile(node)             ← Plugin transforms → Hooks → Printer
  │
  └─ { sql, params }              ← Parameterized output
```

## Project Structure

```
src/
  sumak.ts                   # sumak() factory + Sumak<DB> class
  index.ts                  # Main API — all exports
  pg.ts                     # Sub-path: sumak/pg
  mssql.ts                  # Sub-path: sumak/mssql
  mysql.ts                  # Sub-path: sumak/mysql
  sqlite.ts                 # Sub-path: sumak/sqlite
  schema.ts                 # Sub-path: sumak/schema
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
    expression.ts           # Untyped expression factories (col, lit, eq, etc.)
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
    formatter.ts            # SQL pretty-printer (keyword-aware)
    document.ts             # Wadler-style document algebra (text/line/nest/group/render)
    types.ts                # Printer, PrinterOptions, PrintMode
  dialect/
    pg.ts                   # pgDialect() factory
    mssql.ts                # mssqlDialect() factory
    mysql.ts                # mysqlDialect() factory
    sqlite.ts               # sqliteDialect() factory
    types.ts                # Dialect interface
  plugin/
    types.ts                # SumakPlugin interface
    plugin-manager.ts       # PluginManager — sequential plugin pipeline
    hooks.ts                # Hookable — lifecycle hooks (query:before/after, etc.)
    with-schema.ts          # WithSchemaPlugin — auto schema prefix
    soft-delete.ts          # SoftDeletePlugin — auto WHERE deleted_at IS NULL
    camel-case.ts           # CamelCasePlugin — snake_case → camelCase results
  utils/
    identifier.ts           # Identifier quoting per dialect
    param.ts                # Parameter formatting per dialect
test/
  sumak.test.ts              # Integration: sumak() clean API, plugins, hooks
  ast/                      # 4 files: nodes, visitor, transformer, typed-expression
  builder/                  # 9 files: select, insert, update, delete, expression + typed variants
  printer/                  # 7 files: base, pg, mysql, sqlite, formatter, document, new-nodes
  dialect/                  # 3 files: pg, mysql, sqlite
  plugin/                   # 4 files: plugin-manager, with-schema, soft-delete, camel-case, hooks
  schema/                   # 3 files: column, table, type-utils
  utils/                    # 2 files: identifier, param
```

## Public API

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
- **Current:** 55 test files, 494 tests, 0 lint errors, 0 tsgo errors
