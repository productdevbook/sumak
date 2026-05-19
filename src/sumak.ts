import type { DDLNode, ReindexNode } from "./ast/ddl-nodes.ts"
import type { ASTNode, ExpressionNode, SelectNode, SubqueryNode } from "./ast/nodes.ts"
import type { TclNode } from "./ast/tcl-nodes.ts"
import type { Expression } from "./ast/typed-expression.ts"
import { AlterSequenceBuilder } from "./builder/ddl/alter-sequence.ts"
import { AlterTableBuilder } from "./builder/ddl/alter-table.ts"
import { CreateIndexBuilder } from "./builder/ddl/create-index.ts"
import { CreateSequenceBuilder, DropSequenceBuilder } from "./builder/ddl/create-sequence.ts"
import { CreateTableBuilder } from "./builder/ddl/create-table.ts"
import { CreateViewBuilder, RefreshMaterializedViewBuilder } from "./builder/ddl/create-view.ts"
import {
  AlterTypeAddValueBuilder,
  CreateDomainBuilder,
  CreateTypeEnumBuilder,
  DropDomainBuilder,
  DropTypeBuilder,
} from "./builder/ddl/custom-types.ts"
import {
  DropIndexBuilder,
  DropTableBuilder,
  DropViewBuilder,
  TruncateTableBuilder,
} from "./builder/ddl/drop.ts"
import { CreateExtensionBuilder, DropExtensionBuilder } from "./builder/ddl/extension.ts"
import { LockTableBuilder } from "./builder/ddl/lock-table.ts"
import { AnalyzeBuilder, ReindexBuilder, VacuumBuilder } from "./builder/ddl/maintenance.ts"
import { AlterPolicyBuilder, CreatePolicyBuilder, DropPolicyBuilder } from "./builder/ddl/policy.ts"
import { CreateSchemaBuilder, DropSchemaBuilder } from "./builder/ddl/schema.ts"
import { TruncateBuilder, type TruncateTableArg } from "./builder/ddl/truncate.ts"
import { Col } from "./builder/eb.ts"
import { GraphTableBuilder, graphTable } from "./builder/graph-table.ts"
import { SelectBuilder } from "./builder/select.ts"
import { RestoreBuilder, SoftDeleteBuilder } from "./builder/soft-delete.ts"
import type { SoftDeleteConfig } from "./builder/soft-delete.ts"
import { TypedDeleteBuilder } from "./builder/typed-delete.ts"
import { TypedInsertBuilder } from "./builder/typed-insert.ts"
import { TypedMergeBuilder } from "./builder/typed-merge.ts"
import { TypedSelectBuilder } from "./builder/typed-select.ts"
import { TypedUpdateBuilder } from "./builder/typed-update.ts"
import type { Dialect } from "./dialect/types.ts"
import { MissingDriverError, runExecute, runQuery } from "./driver/execute.ts"
import { runInTransaction } from "./driver/transaction.ts"
import type { TransactionOptions } from "./driver/transaction.ts"
import type { Driver, ExecuteResult, OnQueryListener, Row } from "./driver/types.ts"
import { normalizeQuery } from "./normalize/query.ts"
import type { NormalizeOptions } from "./normalize/types.ts"
import { optimize } from "./optimize/optimizer.ts"
import type { OptimizeOptions, RewriteRule } from "./optimize/types.ts"
import { Hookable } from "./plugin/hooks.ts"
import type { HookName, SumakHooks } from "./plugin/hooks.ts"
import { PluginManager } from "./plugin/plugin-manager.ts"
import { SoftDeletePlugin } from "./plugin/soft-delete.ts"
import type { SumakPlugin } from "./plugin/types.ts"
import { DDLPrinter } from "./printer/ddl.ts"
import { TclPrinter } from "./printer/tcl.ts"
import type { Printer } from "./printer/types.ts"
import type { ColumnBuilder } from "./schema/column.ts"
import { normalizeTableEntry } from "./schema/table.ts"
import type { NormalizedTable, TableConstraints, TableDefinition } from "./schema/table.ts"
import type { SelectRow } from "./schema/types.ts"
import type { CompiledQuery, SQLDialect } from "./types.ts"

/**
 * A single table entry accepted by {@link sumak}. Either a raw columns
 * map (`{ id: serial(), name: text() }`) for the simple case, or a
 * {@link TableDefinition} (from `defineTable(...)`) when the table
 * needs composite keys, table-level CHECK constraints, or named FKs.
 */
type TableInput =
  | Record<string, ColumnBuilder<any, any, any>>
  | TableDefinition<string, Record<string, ColumnBuilder<any, any, any>>>

type TablesConfig = Record<string, TableInput>

/**
 * Resolve a {@link TableInput} to the columns-map shape that the rest
 * of the type system keys off (SelectRow / InsertRow / UpdateRow all
 * index into this). Raw maps pass through; `TableDefinition` is
 * projected onto its `columns` field.
 */
type TableColumns<T> =
  T extends TableDefinition<any, infer Cols>
    ? Cols
    : T extends Record<string, ColumnBuilder<any, any, any>>
      ? T
      : never

/**
 * Database type derived from a {@link TablesConfig}. Equivalent to
 * `{ [K in keyof T]: TableColumns<T[K]> }` but kept at top-level so
 * Sumak<T> reads as "DB shaped by T" rather than "DB = mapped type".
 */
type DBFromConfig<T extends TablesConfig> = { [K in keyof T]: TableColumns<T[K]> }

export interface SumakConfig<T extends TablesConfig> {
  dialect: Dialect
  tables: T
  plugins?: SumakPlugin[]
  /**
   * Optional database driver — enables `.execute()` / `.one()` /
   * `.many()` / `.first()` / `.exec()` on builders and
   * `db.executeCompiled()` / `db.transaction()` on the sumak instance.
   * Without it, sumak still builds and compiles SQL; you just execute
   * yourself.
   */
  driver?: Driver
  /**
   * Observability listener — called synchronously around every driver
   * call with `{ phase: "start" | "end" | "error", sql, params,
   * durationMs?, rowCount?, error? }`. Thrown errors are swallowed so
   * a logger bug can't take down a query. See {@link OnQueryListener}.
   */
  onQuery?: OnQueryListener
  /** Enable AST normalization (NbE). Default: true */
  normalize?: boolean | NormalizeOptions
  /** Enable AST optimization (rewrite rules). Default: true */
  optimizeQueries?: boolean | OptimizeOptions
  /** Custom rewrite rules (in addition to built-in rules). */
  rules?: RewriteRule[]
}

/**
 * Create a fully typed sumak instance.
 *
 * DB type = typeof tables directly. No `InferDB` mapped type.
 * ColumnBuilder carries __select/__insert/__update phantom fields,
 * so SelectType/InsertType/UpdateType resolve via O(1) indexed access
 * instead of conditional type evaluation.
 *
 * ```ts
 * const db = sumak({
 *   dialect: pgDialect(),
 *   tables: {
 *     users: { id: serial(), name: text().notNull() },
 *   },
 * });
 *
 * db.selectFrom("users").select("id", "name")...
 * ```
 */
export function sumak<T extends TablesConfig>(config: SumakConfig<T>): Sumak<DBFromConfig<T>> {
  const normalized = normalizeTablesInput(config.tables)
  return new Sumak<DBFromConfig<T>>(config.dialect, config.plugins ?? [], normalized, {
    normalize: config.normalize,
    optimizeQueries: config.optimizeQueries,
    rules: config.rules,
    driver: config.driver,
    onQuery: config.onQuery,
  })
}

function normalizeTablesInput(tables: TablesConfig): Record<string, NormalizedTable> {
  const out: Record<string, NormalizedTable> = {}
  for (const [name, entry] of Object.entries(tables)) {
    out[name] = normalizeTableEntry(entry)
  }
  return out
}

/**
 * Core sumak instance with hook system.
 */
export class Sumak<DB> {
  private _dialect: Dialect
  private _plugins: PluginManager
  private _pluginsList: SumakPlugin[]
  private _hooks: Hookable
  private _normalizeOpts: NormalizeOptions | false
  private _optimizeOpts: OptimizeOptions | false
  private _customRules: RewriteRule[]
  private _driver?: Driver
  private _onQuery?: OnQueryListener
  /**
   * Back-compat flat view: table name → columns map. The rest of the
   * codebase (diff, introspect fallback paths, test helpers) reads
   * tables this way, so we keep it synchronous with `_schema`.
   * @internal
   */
  _tables: Record<string, Record<string, ColumnBuilder<any, any, any>>>
  /**
   * Canonical schema metadata: table name → { columns, constraints? }.
   * Carries composite primary keys, table-level uniques / CHECKs, and
   * named FKs that can't live on individual columns.
   * @internal
   */
  _schema: Record<string, NormalizedTable>

  constructor(
    dialect: Dialect,
    plugins: SumakPlugin[] = [],
    tables:
      | Record<string, Record<string, ColumnBuilder<any, any, any>>>
      | Record<string, NormalizedTable> = {},
    pipelineOpts: {
      normalize?: boolean | NormalizeOptions
      optimizeQueries?: boolean | OptimizeOptions
      rules?: RewriteRule[]
      driver?: Driver
      onQuery?: OnQueryListener
    } = {},
  ) {
    this._dialect = dialect
    this._pluginsList = [...plugins]
    this._plugins = new PluginManager(plugins)
    this._hooks = new Hookable()
    this._schema = normalizeConstructorTables(tables)
    this._tables = Object.fromEntries(Object.entries(this._schema).map(([k, v]) => [k, v.columns]))
    this._driver = pipelineOpts.driver
    this._onQuery = pipelineOpts.onQuery
    this._normalizeOpts =
      pipelineOpts.normalize === false
        ? false
        : typeof pipelineOpts.normalize === "object"
          ? pipelineOpts.normalize
          : {}
    this._optimizeOpts =
      pipelineOpts.optimizeQueries === false
        ? false
        : typeof pipelineOpts.optimizeQueries === "object"
          ? pipelineOpts.optimizeQueries
          : {}
    this._customRules = pipelineOpts.rules ?? []
  }

  /**
   * Returns the configured driver, or throws {@link MissingDriverError}
   * if the sumak instance was built without one. Used by the execute
   * helpers on builders — most callers should use those instead.
   */
  driver(): Driver {
    if (!this._driver) throw new MissingDriverError()
    return this._driver
  }

  /**
   * The active SQL dialect (`"pg" | "mysql" | "sqlite" | "mssql"`).
   * Exposed so tooling built on top of sumak (migration runner,
   * introspector routing, CLI arg echo, etc.) can branch on the
   * dialect without reaching into private fields.
   */
  dialectName(): SQLDialect {
    return this._dialect.name
  }

  /**
   * Like {@link driver} but returns `undefined` instead of throwing.
   * Useful for code paths that optionally execute.
   */
  driverOrNull(): Driver | undefined {
    return this._driver
  }

  /**
   * Expose the configured observability listener to the execute
   * helpers. `undefined` when none is set; callers should short-circuit
   * without emitting anything.
   */
  onQuery(): OnQueryListener | undefined {
    return this._onQuery
  }

  /**
   * Run an already-compiled query through the configured driver and
   * apply `result:transform` plugins + hooks to the rows. Thin
   * convenience on top of `driver().query(sql, params)` that closes the
   * loop with sumak's result pipeline.
   */
  async executeCompiled(query: CompiledQuery): Promise<Row[]> {
    const rows = await runQuery(
      this.driver(),
      query,
      (r) => this.transformResult(r) as Row[],
      undefined,
      this._onQuery,
    )
    return rows
  }

  /**
   * Fire-and-forget variant: run a compiled statement that returns no
   * rows (INSERT/UPDATE/DELETE without RETURNING, DDL, TCL). Returns
   * `{ affected: number }`.
   */
  async executeCompiledNoRows(query: CompiledQuery): Promise<ExecuteResult> {
    return runExecute(this.driver(), query, undefined, this._onQuery)
  }

  /**
   * Run a block inside a database transaction.
   *
   * ```ts
   * const user = await db.transaction(async (tx) => {
   *   const u = await tx.insertInto("users").values({ name: "Alice" }).returningAll().one()
   *   await tx.insertInto("audit_log").values({ userId: u.id, action: "signup" }).exec()
   *   return u
   * })
   * ```
   *
   * The callback gets a scoped `Sumak` instance whose builders execute
   * inside the transaction. Commits on resolve, rolls back on throw.
   * If the underlying `Driver` implements `transaction()`, sumak uses
   * it (driver owns connection scoping); otherwise BEGIN/COMMIT/
   * ROLLBACK are emitted via the TCL printer and sent through
   * `driver.execute`.
   *
   * Nested `db.transaction()` calls use SQL savepoints via the outer
   * tx's driver — if you need cross-connection nesting semantics,
   * implement `Driver.transaction` with your own scoping rules.
   */
  async transaction<T>(
    fn: (tx: Sumak<DB>) => Promise<T>,
    opts: TransactionOptions = {},
  ): Promise<T> {
    const driver = this.driver()
    return runInTransaction(
      driver,
      this._dialect.name,
      async (scoped) => {
        const scopedDb = new Sumak<DB>(this._dialect, this._pluginsArray(), this._tables, {
          normalize: this._normalizeOpts === false ? false : this._normalizeOpts,
          optimizeQueries: this._optimizeOpts === false ? false : this._optimizeOpts,
          rules: this._customRules,
          driver: scoped,
          onQuery: this._onQuery,
        })
        // Inherit registered hooks on the scoped instance so the tx
        // block sees the same `result:transform` / `query:before` wiring
        // the parent does.
        scopedDb._hooks = this._hooks
        return fn(scopedDb)
      },
      { ...opts, onQuery: this._onQuery },
    )
  }

  /** @internal — the plugins list used to rebuild a scoped Sumak for transactions. */
  private _pluginsArray(): SumakPlugin[] {
    return this._pluginsList
  }

  /**
   * Register a hook handler. Returns an unregister function.
   *
   * ```ts
   * const off = db.hook("query:before", (ctx) => { ... });
   * off(); // unregister
   * ```
   */
  hook<K extends HookName>(name: K, handler: SumakHooks[K]): () => void {
    return this._hooks.hook(name, handler)
  }

  selectFrom<T extends keyof DB & string>(
    table: T,
    alias?: string,
  ): TypedSelectBuilder<DB, T, SelectRow<DB, T>> {
    return new TypedSelectBuilder<DB, T, SelectRow<DB, T>>(
      new SelectBuilder().from(table, alias),
      table,
      this._dialect.createPrinter(),
      (node: ASTNode) => this.compile(node),
      this,
    )
  }

  /**
   * **Spike.** SQL:2023 Part 16 (SQL/PGQ) property-graph query entry
   * point. Returns a `GraphTableBuilder` that emits
   * `FROM GRAPH_TABLE(graph MATCH ... COLUMNS (...))` in standard SQL or
   * `FROM cypher('graph', $$...$$)` on Apache AGE (PG extension — not
   * yet wired up; coming in phase 2 of the PGQ work).
   *
   * ```ts
   * const g = db.graphTable("social")
   *   .match`(p:Person)-[:FOLLOWS]->(f:Person) WHERE p.name = ${"Alice"}`
   *   .columns({ follower: "p.name", followee: "f.name" })
   *   .as("g")
   *
   * db.selectFromGraph(g).select("follower", "followee").toSQL()
   * ```
   *
   * @experimental — surface may change as the spike matures.
   */
  graphTable(name: string): GraphTableBuilder {
    return graphTable(name)
  }

  /**
   * SELECT from a `GraphTableBuilder`. Wraps the graph table in the
   * normal SELECT pipeline so you get WHERE / ORDER BY / LIMIT / joins
   * for free on top of the projected columns.
   *
   * @experimental — see `graphTable()`.
   */
  selectFromGraph(
    g: GraphTableBuilder,
  ): TypedSelectBuilder<DB, keyof DB & string, Record<string, unknown>> {
    const node = g.build()
    return new TypedSelectBuilder(
      new SelectBuilder({
        type: "select",
        distinct: false,
        columns: [],
        from: node,
        joins: [],
        groupBy: [],
        orderBy: [],
        ctes: [],
      }),
      (node.alias ?? node.graph) as any,
      this._dialect.createPrinter(),
      (n: ASTNode) => this.compile(n),
    )
  }

  /**
   * Scope every unqualified table reference in chained builder calls to
   * the given schema. Returns a proxy with the same builder API that
   * prefixes table names with `"<schema>."` when they don't already
   * contain a dot.
   *
   * ```ts
   * db.withSchema("tenant_42")
   *   .selectFrom("users")       // → FROM "tenant_42"."users"
   *   .select("id")
   *   .toSQL()
   *
   * // Fully-qualified names are left alone:
   * db.withSchema("tenant_42").selectFrom("audit.logs")
   * // → FROM "audit"."logs"
   * ```
   *
   * The scope is request-local: the `db` instance itself is unchanged,
   * and any other query started from `db` (not the returned proxy) uses
   * the default schema.
   */
  withSchema(schema: string): ScopedSumak<DB> {
    return new ScopedSumak<DB>(this, schema)
  }

  /**
   * SELECT from a subquery (derived table).
   *
   * ```ts
   * const sub = db.selectFrom("users").select("id", "name")
   * db.selectFromSubquery(sub, "u").selectAll().compile(db.printer())
   * // SELECT * FROM (SELECT "id", "name" FROM "users") AS "u"
   * ```
   */
  selectFromSubquery<Alias extends string>(
    subquery: { build(): SelectNode },
    alias: Alias,
  ): TypedSelectBuilder<DB, keyof DB & string, Record<string, unknown>> {
    const sub: SubqueryNode = {
      type: "subquery",
      query: subquery.build(),
      alias,
    }
    return new TypedSelectBuilder(
      new SelectBuilder().from(sub),
      alias as any,
      this._dialect.createPrinter(),
      (n: ASTNode) => this.compile(n),
    )
  }

  /**
   * Start a SELECT whose FROM is a `(VALUES (...)) AS t(cols)` derived
   * table. The `valuesClause` helper builds the node and checks row
   * arity; plug the result in here to get a typed builder whose output
   * row keys off the column-alias list.
   *
   * ```ts
   * const seed = valuesClause({
   *   alias: "seed",
   *   columns: ["id", "label"],
   *   rows: [[val(1), val("one")], [val(2), val("two")]],
   * })
   * db.selectFromValues(seed).selectAll().many()
   * // SELECT * FROM (VALUES (1, 'one'), (2, 'two')) AS "seed"("id", "label")
   * ```
   */
  selectFromValues(
    values: import("./ast/nodes.ts").ValuesClauseNode,
  ): TypedSelectBuilder<DB, keyof DB & string, Record<string, unknown>> {
    return new TypedSelectBuilder<DB, keyof DB & string, Record<string, unknown>>(
      new SelectBuilder().from(values),
      values.alias as any,
      this._dialect.createPrinter(),
      (n: ASTNode) => this.compile(n),
      this as unknown as import("./driver/execute.ts").SumakExecutor,
    )
  }

  /**
   * SELECT COUNT(*) FROM table — convenience shorthand.
   */
  selectCount<T extends keyof DB & string>(table: T): TypedSelectBuilder<DB, T, { count: number }> {
    const star: ExpressionNode = { type: "star" }
    const countFn: ExpressionNode = {
      type: "function_call",
      name: "COUNT",
      args: [star],
      alias: "count",
    }
    return new TypedSelectBuilder<DB, T, { count: number }>(
      new SelectBuilder().columns(countFn).from(table),
      table,
      this._dialect.createPrinter(),
      (node: ASTNode) => this.compile(node),
    )
  }

  insertInto<T extends keyof DB & string>(table: T): TypedInsertBuilder<DB, T> {
    return new TypedInsertBuilder<DB, T>(
      table,
      this._dialect.createPrinter(),
      (node: ASTNode) => this.compile(node),
      undefined,
      this,
    )
  }

  update<T extends keyof DB & string>(table: T): TypedUpdateBuilder<DB, T> {
    return new TypedUpdateBuilder<DB, T>(
      table,
      this._dialect.createPrinter(),
      (node: ASTNode) => this.compile(node),
      undefined,
      this,
    )
  }

  deleteFrom<T extends keyof DB & string>(table: T): TypedDeleteBuilder<DB, T> {
    return new TypedDeleteBuilder<DB, T>(
      table,
      this._dialect.createPrinter(),
      (node: ASTNode) => this.compile(node),
      undefined,
      false,
      this,
    )
  }

  /**
   * Explicit soft-delete — `UPDATE table SET <col> = CURRENT_TIMESTAMP WHERE ... AND <col> IS NULL`.
   * The trailing `IS NULL` predicate makes the write race-safe against a
   * concurrent restore. Requires a registered `softDelete` plugin whose
   * `tables` list contains this table.
   *
   * ```ts
   * db.softDelete("users").where(({ id }) => id.eq(1)).toSQL()
   * ```
   */
  softDelete<T extends keyof DB & string>(table: T): SoftDeleteBuilder<DB, T> {
    const cfg = this._resolveSoftDeleteConfig(table)
    return new SoftDeleteBuilder<DB, T>({
      table,
      cfg,
      printer: this._dialect.createPrinter(),
      compile: (n: ASTNode) => this.compile(n),
    })
  }

  /**
   * Restore a previously soft-deleted row. Race-safe: the generated
   * UPDATE only targets rows that are currently marked deleted.
   *
   * ```ts
   * db.restore("users").where(({ id }) => id.eq(1)).toSQL()
   * ```
   */
  restore<T extends keyof DB & string>(table: T): RestoreBuilder<DB, T> {
    const cfg = this._resolveSoftDeleteConfig(table)
    return new RestoreBuilder<DB, T>({
      table,
      cfg,
      printer: this._dialect.createPrinter(),
      compile: (n: ASTNode) => this.compile(n),
    })
  }

  private _resolveSoftDeleteConfig(table: string): SoftDeleteConfig {
    const plugin = this._plugins.getByInstance(SoftDeletePlugin)
    if (!plugin) {
      throw new Error(
        `db.softDelete()/restore() requires the softDelete plugin to be registered.\n` +
          `  Add it in sumak({ plugins: [softDelete({ tables: ["${table}"] })] }).`,
      )
    }
    const cfg = plugin.getConfig()
    if (!cfg.tables.has(table)) {
      throw new Error(
        `Table "${table}" is not configured for soft-delete.\n` +
          `  Add it to softDelete({ tables: [...] }) — currently configured: ` +
          `[${[...cfg.tables].map((t) => `"${t}"`).join(", ")}].`,
      )
    }
    return { column: cfg.column, flag: cfg.flag }
  }

  /**
   * MERGE INTO target USING source ON condition.
   *
   * ```ts
   * db.mergeInto("users", {
   *   source: "staging",
   *   alias: "s",                             // optional; defaults to source name
   *   on: ({ target, source }) => target.id.eq(source.id),
   * })
   *   .whenMatchedThenUpdate({ name: "updated" })
   *   .whenNotMatchedThenInsert({ name: "new", email: "e@x.com" })
   *   .toSQL()
   * ```
   *
   */
  mergeInto<T extends keyof DB & string, S extends keyof DB & string>(
    target: T,
    options: {
      source: S
      alias?: string
      on: (proxies: {
        target: { [K in keyof DB[T] & string]: Col<any> }
        source: { [K in keyof DB[S] & string]: Col<any> }
      }) => Expression<boolean>
    },
  ): TypedMergeBuilder<DB, T, S> {
    const source = options.source
    const alias = options.alias ?? (source as unknown as string)
    const onCallback = options.on

    const makeProxy = (prefix: string) =>
      new Proxy(
        {},
        {
          get(_t: any, colName: string) {
            return new Col(colName, prefix)
          },
        },
      )
    const proxies = {
      target: makeProxy(target),
      source: makeProxy(alias),
    } as any
    const onExpr = onCallback(proxies)
    return new TypedMergeBuilder<DB, T, S>(
      target,
      source,
      alias,
      onExpr,
      this._dialect.createPrinter(),
      (node: ASTNode) => this.compile(node),
    )
  }

  /**
   * Compile an AST node through the full 7-layer pipeline:
   *
   * ```
   * AST → Plugin transform → Hooks → Normalize (NbE) → Optimize (rewrite rules) → Print → Plugin query transform → Hooks
   * ```
   */
  compile(node: ASTNode | DDLNode | TclNode): CompiledQuery {
    // Route TCL nodes directly — no plugins, hooks, normalize, or optimize apply.
    if (typeof node.type === "string" && node.type.startsWith("tcl_")) {
      return new TclPrinter(this._dialect.name).print(node as TclNode)
    }
    // Route DDL nodes directly — DDL itself is not subject to plugins
    // (you cannot "soft-delete" a CREATE TABLE). However, when the DDL
    // carries an embedded SELECT (CREATE TABLE … AS SELECT, CREATE
    // VIEW AS SELECT), the inner SELECT MUST still pass through the
    // full pipeline — plugin transforms, hooks, normalize, optimize —
    // otherwise a `CREATE VIEW tenant_orders AS SELECT * FROM orders`
    // on a multi-tenant table silently captures every tenant's rows
    // into the view. Route `asSelect` recursively through compile().
    if (isDDLNode(node)) {
      return new DDLPrinter(this._dialect.name, (sel) => this.compile(sel)).print(node as DDLNode)
    }

    // 1. Plugin AST transform
    let ast = this._plugins.transformNode(node as ASTNode)

    // 2. Type-specific before hooks
    const table = this._extractTableName(ast)
    switch (ast.type) {
      case "select": {
        const result = this._hooks.callHook("select:before", { node: ast, table })
        if (result) ast = result
        break
      }
      case "insert": {
        const result = this._hooks.callHook("insert:before", { node: ast, table })
        if (result) ast = result
        break
      }
      case "update": {
        const result = this._hooks.callHook("update:before", { node: ast, table })
        if (result) ast = result
        break
      }
      case "delete": {
        const result = this._hooks.callHook("delete:before", { node: ast, table })
        if (result) ast = result
        break
      }
    }

    // 3. Generic before hook
    const beforeResult = this._hooks.callHook("query:before", { node: ast, table })
    if (beforeResult) ast = beforeResult

    // 4. Normalize (NbE) — flatten AND/OR, deduplicate predicates, fold constants
    if (this._normalizeOpts !== false) {
      ast = normalizeQuery(ast, this._normalizeOpts)
    }

    // 5. Optimize (rewrite rules) — predicate pushdown, subquery flattening
    if (this._optimizeOpts !== false) {
      const rules =
        this._customRules.length > 0
          ? [...((this._optimizeOpts as OptimizeOptions).rules ?? []), ...this._customRules]
          : undefined
      ast = optimize(ast, {
        ...(this._optimizeOpts as OptimizeOptions),
        rules,
      }) as ASTNode
    }

    // 6. Print to SQL
    const printer = this._dialect.createPrinter()
    let query = printer.print(ast)

    // 7. After hook
    const afterResult = this._hooks.callHook("query:after", { node: ast, table, query })
    if (afterResult) query = afterResult

    return query
  }

  /**
   * Transform result rows through plugins and hooks. The optional
   * `ctx` argument propagates AST context (source table, column map)
   * down to both plugin `transformResult` calls and the
   * `result:transform` hook.
   */
  transformResult(
    rows: Record<string, unknown>[],
    ctx?: import("./plugin/types.ts").ResultContext,
  ): Record<string, unknown>[] {
    let result = this._plugins.transformResult(rows, ctx)
    const hookResult = this._hooks.callHook("result:transform", result, ctx)
    if (hookResult) result = hookResult
    return result
  }

  printer(): Printer {
    return this._dialect.createPrinter()
  }

  /** Schema builder for DDL operations (CREATE TABLE, ALTER TABLE, etc.) */
  get schema(): SchemaBuilder {
    return new SchemaBuilder(this._dialect.name)
  }

  /**
   * Generate CREATE TABLE SQL for all tables in the schema.
   *
   * Bridges the gap between `sumak({ tables })` definition and DDL.
   * Reads ColumnBuilder metadata (dataType, notNull, primaryKey, references)
   * and produces CREATE TABLE statements.
   *
   * ```ts
   * const db = sumak({ dialect: pgDialect(), tables: { users: { id: serial(), name: text().notNull() } } })
   * const ddl = db.generateDDL()
   * // [{ sql: 'CREATE TABLE "users" ("id" serial PRIMARY KEY NOT NULL, "name" text NOT NULL)', params: [] }]
   * ```
   */
  generateDDL(options?: { ifNotExists?: boolean }): CompiledQuery[] {
    const results: CompiledQuery[] = []

    for (const [tableName, columns] of Object.entries(this._tables)) {
      // One printer per statement — matches the contract used by
      // compileDDL() and avoids any cross-iteration param carryover
      // if a column default or future asSelect pushes into the
      // printer's params between the inner `renderSelect` and the
      // outer `print()`'s snapshot.
      const printer = new DDLPrinter(this._dialect.name, (sel) => this.compile(sel))
      const builder = new CreateTableBuilder(tableName)
      let tb = options?.ifNotExists ? builder.ifNotExists() : builder

      for (const [colName, colBuilder] of Object.entries(
        columns as Record<string, ColumnBuilder<any, any, any>>,
      )) {
        const def = colBuilder._def
        tb = tb.addColumn(colName, def.dataType, (c) => {
          let col = c
          if (def.isPrimaryKey) col = col.primaryKey()
          if (def.isNotNull && !def.isPrimaryKey) col = col.notNull()
          if (def.isUnique) {
            col = def.uniqueNullsNotDistinct ? col.unique({ nullsNotDistinct: true }) : col.unique()
          }
          if (def.hasDefault && def.defaultValue !== undefined) {
            const dv = def.defaultValue
            const lit =
              typeof dv === "string"
                ? { type: "literal" as const, value: dv }
                : typeof dv === "number" || typeof dv === "boolean"
                  ? { type: "literal" as const, value: dv }
                  : dv === null
                    ? { type: "literal" as const, value: null }
                    : { type: "literal" as const, value: String(dv) }
            col = col.defaultTo(lit)
          }
          if (def.references) {
            col = col.references(def.references.table, def.references.column)
            if (def.references.onDelete) col = col.onDelete(def.references.onDelete)
            if (def.references.onUpdate) col = col.onUpdate(def.references.onUpdate)
          }
          return col
        })
      }

      results.push(printer.print(tb.build()))
    }
    return results
  }

  /** Compile a DDL node to SQL. */
  compileDDL(node: DDLNode): CompiledQuery {
    // Same as compile(): embedded SELECTs in AS SELECT / asSelect must
    // route through the full pipeline so plugins apply.
    const printer = new DDLPrinter(this._dialect.name, (sel) => this.compile(sel))
    return printer.print(node)
  }

  private _extractTableName(node: ASTNode): string | undefined {
    return _extractTableName(node)
  }
}

const DDL_NODE_TYPES = new Set<string>([
  "create_table",
  "alter_table",
  "drop_table",
  "create_index",
  "drop_index",
  "create_view",
  "drop_view",
  "refresh_materialized_view",
  "truncate_table",
  "create_schema",
  "drop_schema",
  "comment_on",
  "create_sequence",
  "drop_sequence",
  "alter_sequence",
  "vacuum",
  "analyze",
  "reindex",
  "create_policy",
  "drop_policy",
  "alter_policy",
  "create_extension",
  "drop_extension",
  "create_type_enum",
  "drop_type",
  "create_domain",
  "drop_domain",
  "alter_type_add_value",
  "lock_table",
])

function isDDLNode(node: { type: string }): boolean {
  return DDL_NODE_TYPES.has(node.type)
}

function _extractTableName(node: ASTNode): string | undefined {
  switch (node.type) {
    case "select":
      return node.from?.type === "table_ref" ? node.from.name : undefined
    case "insert":
      return node.table.name
    case "update":
      return node.table.name
    case "delete":
      return node.table.name
    case "merge":
      return node.target.name
    default:
      return undefined
  }
}

/**
 * Schema builder — entry point for DDL operations.
 *
 * ```ts
 * db.schema.createTable("users").addColumn("id", "serial", c => c.primaryKey()).build()
 * db.schema.alterTable("users").addColumn("age", "integer").build()
 * db.schema.dropTable("users").ifExists().build()
 * ```
 */
export class SchemaBuilder {
  private _dialect: SQLDialect

  constructor(dialect: SQLDialect) {
    this._dialect = dialect
  }

  createTable(table: string, schema?: string): CreateTableBuilder {
    return new CreateTableBuilder(table, schema)
  }

  alterTable(table: string, schema?: string): AlterTableBuilder {
    return new AlterTableBuilder(table, schema)
  }

  createIndex(name: string): CreateIndexBuilder {
    return new CreateIndexBuilder(name)
  }

  createView(name: string, schema?: string): CreateViewBuilder {
    return new CreateViewBuilder(name, schema)
  }

  dropTable(table: string, schema?: string): DropTableBuilder {
    return new DropTableBuilder(table, schema)
  }

  dropIndex(name: string): DropIndexBuilder {
    return new DropIndexBuilder(name)
  }

  dropView(name: string): DropViewBuilder {
    return new DropViewBuilder(name)
  }

  /**
   * PG-only — `REFRESH MATERIALIZED VIEW [CONCURRENTLY] <name>
   * [WITH NO DATA]`. Rebuilds the cached result of a MATERIALIZED VIEW
   * created via `createView(...).materialized()`. Throws on MySQL /
   * SQLite / MSSQL at print time via the `MATERIALIZED_VIEW` feature
   * flag.
   *
   * ```ts
   * // Rebuild in the background — readers see old data until done.
   * db.compileDDL(db.schema.refreshMaterializedView("daily_stats").concurrently().build())
   * ```
   */
  refreshMaterializedView(name: string, schema?: string): RefreshMaterializedViewBuilder {
    return new RefreshMaterializedViewBuilder(name, schema)
  }

  truncateTable(table: string, schema?: string): TruncateTableBuilder {
    return new TruncateTableBuilder(table, schema)
  }

  /**
   * Multi-table TRUNCATE entry point — exposes the full PG grammar
   * (`ONLY`, `RESTART IDENTITY` / `CONTINUE IDENTITY`, `CASCADE` /
   * `RESTRICT`, comma-separated table list). On MySQL / MSSQL only the
   * simple form is supported; the printer refuses any PG-specific
   * modifier and any multi-table list. SQLite has no TRUNCATE — the
   * printer refuses with a pointer at `db.deleteFrom(t).allRows()` as
   * the workaround.
   *
   * Pass a single table name (string) for the common case, or an array
   * to truncate several tables atomically (PG only).
   *
   * ```ts
   * db.compileDDL(db.schema.truncate("users").build())
   *   // PG / MySQL / MSSQL: TRUNCATE TABLE "users"
   *
   * db.compileDDL(db.schema.truncate(["users", "orders"]).cascade().build())
   *   // PG only: TRUNCATE TABLE "users", "orders" CASCADE
   * ```
   */
  truncate(tables: TruncateTableArg | TruncateTableArg[]): TruncateBuilder {
    return new TruncateBuilder(tables)
  }

  createSchema(name: string): CreateSchemaBuilder {
    return new CreateSchemaBuilder(name)
  }

  dropSchema(name: string): DropSchemaBuilder {
    return new DropSchemaBuilder(name)
  }

  /**
   * `CREATE SEQUENCE [IF NOT EXISTS] <name> [AS …] [INCREMENT …] …`.
   * PG and MSSQL only — MySQL and SQLite have no sequence object and
   * the DDL printer refuses on those dialects.
   *
   * ```ts
   * db.compileDDL(
   *   db.schema.createSequence("order_no").start(1000).increment(1).build()
   * )
   * // PG/MSSQL: CREATE SEQUENCE "order_no" INCREMENT BY 1 START WITH 1000
   * ```
   */
  createSequence(name: string, schema?: string): CreateSequenceBuilder {
    return new CreateSequenceBuilder(name, schema)
  }

  /**
   * `DROP SEQUENCE [IF EXISTS] <name> [CASCADE]`. PG and MSSQL only;
   * MySQL/SQLite refuse via the `SEQUENCES` feature gate. `CASCADE` is
   * PG-only (MSSQL sequences aren't auto-dropped with dependents).
   */
  dropSequence(name: string, schema?: string): DropSequenceBuilder {
    return new DropSequenceBuilder(name, schema)
  }

  /**
   * `ALTER SEQUENCE [IF EXISTS] <name> [AS …] [INCREMENT …] [RESTART …] …`.
   * PG and MSSQL only — the same dialect support and feature gate as
   * `CREATE SEQUENCE`.
   *
   * Most common workflows:
   *
   * ```ts
   * // Reset a counter back to 1 without dropping & recreating.
   * db.compileDDL(db.schema.alterSequence("order_no").restartWith(1).build())
   * // PG/MSSQL: ALTER SEQUENCE "order_no" RESTART WITH 1
   *
   * // Retune the cache and the step.
   * db.compileDDL(
   *   db.schema.alterSequence("order_no").cache(100).increment(2).build()
   * )
   * // PG/MSSQL: ALTER SEQUENCE "order_no" INCREMENT BY 2 CACHE 100
   * ```
   *
   * The printer refuses MSSQL-incompatible clauses (`AS`, `START WITH`,
   * `OWNED BY`, `IF EXISTS`) up front so a portable migration that
   * needs to run on both dialects fails at compile time rather than at
   * the database.
   */
  alterSequence(name: string, schema?: string): AlterSequenceBuilder {
    return new AlterSequenceBuilder(name, schema)
  }

  /**
   * PostgreSQL `VACUUM [ ( option, ... ) ] [ table, ... ]` — reclaim
   * row storage left over by dead tuples. PG only. Without any
   * `.table()` / `.tables()` call the emitted SQL is database-wide
   * (the bare `VACUUM` form).
   *
   * ```ts
   * db.compileDDL(db.schema.vacuum().table("users").analyze().build())
   * // PG: VACUUM (ANALYZE) "users"
   * ```
   *
   * Refused on MySQL / SQLite / MSSQL at print time — those engines
   * either have a different surface (MySQL `OPTIMIZE TABLE`, SQLite
   * whole-DB option-less VACUUM, MSSQL `DBCC SHRINKDATABASE`) or no
   * equivalent at all.
   */
  vacuum(): VacuumBuilder {
    return new VacuumBuilder()
  }

  /**
   * PostgreSQL `ANALYZE [ ( option, ... ) ] [ table, ... ]` — refresh
   * the planner's row statistics. PG only.
   *
   * ```ts
   * db.compileDDL(db.schema.analyze().table("users").build())
   * // PG: ANALYZE "users"
   * ```
   */
  analyze(): AnalyzeBuilder {
    return new AnalyzeBuilder()
  }

  /**
   * PostgreSQL `REINDEX { INDEX | TABLE | SCHEMA | DATABASE | SYSTEM }
   * [CONCURRENTLY] <name>` — rebuild the named indexes. PG only.
   *
   * ```ts
   * db.compileDDL(db.schema.reindex("TABLE", "users").concurrently().build())
   * // PG: REINDEX TABLE CONCURRENTLY "users"
   * ```
   *
   * MSSQL has `ALTER INDEX … REBUILD`, MySQL has `OPTIMIZE TABLE` /
   * `ALTER TABLE … FORCE`, SQLite uses its own `REINDEX [name]`
   * shape — each refused at print time, dialect-aware variants are
   * follow-up work.
   */
  reindex(target: ReindexNode["target"], name: string): ReindexBuilder {
    return new ReindexBuilder(target, name)
  }

  /**
   * PostgreSQL Row Level Security — `CREATE POLICY <name> ON <table>
   * [AS PERMISSIVE | RESTRICTIVE] [FOR …] [TO …] [USING (…)] [WITH
   * CHECK (…)]`. PG only — the DDL printer refuses on every non-PG
   * dialect via the `ROW_LEVEL_SECURITY` feature gate.
   *
   * Pair with `db.schema.alterTable(...).enableRowLevelSecurity()` to
   * turn the per-row machinery on before any policy can take effect.
   *
   * ```ts
   * db.compileDDL(
   *   db.schema.alterTable("orders").enableRowLevelSecurity().build(),
   * )
   * db.compileDDL(
   *   db.schema
   *     .createPolicy("tenant_isolation")
   *     .on("orders")
   *     .for("ALL")
   *     .using(sql`tenant_id = current_setting('app.tenant_id')::int`)
   *     .withCheck(sql`tenant_id = current_setting('app.tenant_id')::int`)
   *     .build(),
   * )
   * ```
   */
  createPolicy(name: string): CreatePolicyBuilder {
    return new CreatePolicyBuilder(name)
  }

  /**
   * `DROP POLICY [IF EXISTS] <name> ON <table> [CASCADE]`. PG only;
   * pairs with {@link createPolicy}.
   */
  dropPolicy(name: string): DropPolicyBuilder {
    return new DropPolicyBuilder(name)
  }

  /**
   * `ALTER POLICY <name> ON <table>` — modify an existing RLS policy
   * in-place. Two distinct forms share the builder:
   *
   *  - Rename — `.on(table).renameTo(newName)`.
   *  - Modify — any combination of `.to(...roles)`, `.using(expr)`,
   *    `.withCheck(expr)`. At least one must be set or PG rejects the
   *    statement.
   *
   * The two forms are mutually exclusive — chaining `.renameTo()`
   * after any modify-form chain (or vice versa) is a builder-side
   * mistake the printer refuses at compile time.
   *
   * The policy *kind* (permissive vs restrictive) and the *command*
   * (`FOR ALL` / `SELECT` / …) are immutable in PG — to change those
   * you have to DROP + CREATE the policy.
   *
   * ```ts
   * db.compileDDL(
   *   db.schema
   *     .alterPolicy("tenant_isolation")
   *     .on("orders")
   *     .using(sql`tenant_id = current_setting('app.tenant_id')::int`)
   *     .build(),
   * )
   * ```
   *
   * PG only — the DDL printer refuses on every non-PG dialect via the
   * `ROW_LEVEL_SECURITY` feature gate.
   */
  alterPolicy(name: string): AlterPolicyBuilder {
    return new AlterPolicyBuilder(name)
  }

  /**
   * `CREATE EXTENSION [IF NOT EXISTS] name
   *   [SCHEMA schema] [VERSION 'v'] [CASCADE]`.
   *
   * ```ts
   * db.schema.createExtension("btree_gist").ifNotExists().build()
   * // CREATE EXTENSION IF NOT EXISTS "btree_gist"
   * ```
   *
   * PostgreSQL-only. The printer throws on MySQL / SQLite / MSSQL.
   */
  createExtension(name: string): CreateExtensionBuilder {
    return new CreateExtensionBuilder(name)
  }

  /**
   * `DROP EXTENSION [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`.
   *
   * Accepts either a single name or a `string[]` — PG permits a
   * comma-separated list, so the builder preserves that.
   *
   * ```ts
   * db.schema.dropExtension(["uuid-ossp", "pgcrypto"]).ifExists().build()
   * // DROP EXTENSION IF EXISTS "uuid-ossp", "pgcrypto"
   * ```
   *
   * PostgreSQL-only. The printer throws on MySQL / SQLite / MSSQL.
   */
  dropExtension(name: string | string[]): DropExtensionBuilder {
    return new DropExtensionBuilder(name)
  }

  /**
   * `CREATE TYPE <name> AS ENUM (...)`. PostgreSQL-only.
   */
  createTypeEnum(name: string): CreateTypeEnumBuilder {
    return new CreateTypeEnumBuilder(name)
  }

  /**
   * `DROP TYPE [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`. PG-only.
   */
  dropType(name: string | string[]): DropTypeBuilder {
    return new DropTypeBuilder(name)
  }

  /**
   * `CREATE DOMAIN <name> AS <type>` with optional DEFAULT / NOT NULL /
   * CHECK. PostgreSQL-only.
   */
  createDomain(name: string, dataType?: string): CreateDomainBuilder {
    return new CreateDomainBuilder(name, dataType)
  }

  /**
   * `DROP DOMAIN [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`. PG-only.
   */
  dropDomain(name: string | string[]): DropDomainBuilder {
    return new DropDomainBuilder(name)
  }

  /**
   * `ALTER TYPE <name> ADD VALUE [IF NOT EXISTS] '<v>'
   *   [BEFORE | AFTER '<existing>']`. PostgreSQL-only.
   *
   * Extends a previously-created enum with a new label, optionally
   * positioned relative to an existing label. Without `.before(...)` /
   * `.after(...)` PG appends the new label at the end (which is the
   * sort order too).
   *
   * ```ts
   * db.compileDDL(
   *   db.schema.alterTypeAddValue("order_status").value("refunded").build(),
   * )
   * // ALTER TYPE "order_status" ADD VALUE 'refunded'
   * ```
   *
   * **Migration caveat**: ADD VALUE is incompatible with normal
   * transactional migration tooling — emit it as a standalone step
   * (no surrounding BEGIN/COMMIT) on PG 11 and earlier, and on PG 12+
   * still don't use the new value in the same transaction. See
   * {@link AlterTypeAddValueBuilder} for the full quirk list.
   */
  alterTypeAddValue(name: string): AlterTypeAddValueBuilder {
    return new AlterTypeAddValueBuilder(name)
  }

  /**
   * PostgreSQL `LOCK [TABLE] [ONLY] name [, …] [IN lock_mode MODE]
   * [NOWAIT]` — explicit table-level lock inside the current transaction.
   *
   * PostgreSQL-only. Throws on MySQL/SQLite/MSSQL via `LOCK_TABLE_STMT`.
   */
  lockTable(tables: string | string[]): LockTableBuilder {
    return new LockTableBuilder(tables)
  }
}

/**
 * Scope-limited view of a Sumak instance — returned by `db.withSchema()`.
 * Prefixes unqualified table names with the configured schema before
 * delegating to the parent instance. Fully-qualified dotted names
 * (`"audit.logs"`) are left alone.
 */
export class ScopedSumak<DB> {
  constructor(
    private readonly _db: Sumak<DB>,
    private readonly _schema: string,
  ) {}

  private _qualify<T extends keyof DB & string>(table: T): string {
    return table.includes(".") ? table : `${this._schema}.${table}`
  }

  selectFrom<T extends keyof DB & string>(
    table: T,
    alias?: string,
  ): TypedSelectBuilder<DB, T, SelectRow<DB, T>> {
    return this._db.selectFrom(this._qualify(table) as T, alias)
  }

  insertInto<T extends keyof DB & string>(table: T): TypedInsertBuilder<DB, T> {
    return this._db.insertInto(this._qualify(table) as T)
  }

  update<T extends keyof DB & string>(table: T): TypedUpdateBuilder<DB, T> {
    return this._db.update(this._qualify(table) as T)
  }

  deleteFrom<T extends keyof DB & string>(table: T): TypedDeleteBuilder<DB, T> {
    return this._db.deleteFrom(this._qualify(table) as T)
  }

  softDelete<T extends keyof DB & string>(table: T): SoftDeleteBuilder<DB, T> {
    return this._db.softDelete(this._qualify(table) as T)
  }

  restore<T extends keyof DB & string>(table: T): RestoreBuilder<DB, T> {
    return this._db.restore(this._qualify(table) as T)
  }

  mergeInto<T extends keyof DB & string, S extends keyof DB & string>(
    target: T,
    options: {
      source: S
      alias?: string
      on: (proxies: {
        target: { [K in keyof DB[T] & string]: Col<any> }
        source: { [K in keyof DB[S] & string]: Col<any> }
      }) => Expression<boolean>
    },
  ): TypedMergeBuilder<DB, T, S> {
    // If the caller didn't pass an alias, derive it from the source's
    // unqualified name — otherwise `Sumak.mergeInto`'s default
    // (`alias ?? source`) would set the alias to the fully-qualified
    // name `"schema.table"`, which the printer then quotes as one
    // identifier (`"schema.table"`) instead of two.
    const sourceName = options.source as unknown as string
    const derivedAlias = options.alias ?? (sourceName.split(".").at(-1) as string)
    return this._db.mergeInto(this._qualify(target) as T, {
      ...options,
      source: this._qualify(options.source) as S,
      alias: derivedAlias,
    })
  }
}

/**
 * Accept either the legacy shape (table → columns map) or the
 * normalized shape (table → `{ columns, constraints? }`). Leaf values
 * are `ColumnBuilder` instances in the legacy shape; in the normalized
 * shape the entry is always an object with a `columns` field.
 */
function normalizeConstructorTables(
  tables:
    | Record<string, Record<string, ColumnBuilder<any, any, any>>>
    | Record<string, NormalizedTable>,
): Record<string, NormalizedTable> {
  const out: Record<string, NormalizedTable> = {}
  for (const [name, entry] of Object.entries(tables)) {
    if (
      entry &&
      typeof entry === "object" &&
      "columns" in entry &&
      isColumnsRecord(entry.columns)
    ) {
      const normalized = entry as NormalizedTable
      const lowered: NormalizedTable = { columns: normalized.columns }
      if (normalized.constraints) {
        ;(lowered as { constraints?: unknown }).constraints = normalized.constraints
      }
      if (normalized.indexes) {
        ;(lowered as { indexes?: unknown }).indexes = normalized.indexes
      }
      out[name] = lowered
    } else {
      out[name] = { columns: entry as Record<string, ColumnBuilder<any, any, any>> }
    }
  }
  return out
}

function isColumnsRecord(value: unknown): value is Record<string, ColumnBuilder<any, any, any>> {
  if (value === null || typeof value !== "object") return false
  // Empty objects are valid columns records (zero-column tables aren't
  // useful but we don't want to misclassify them as legacy). For
  // non-empty objects, any value with a `_def` field is a ColumnBuilder.
  for (const v of Object.values(value)) {
    return v !== null && typeof v === "object" && "_def" in v
  }
  return true
}

/**
 * Unused in this file but kept alongside {@link normalizeConstructorTables}
 * so anyone reading the module can see the two sides of the input path.
 */
export type { TableConstraints }
