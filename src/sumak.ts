import type { DDLNode } from "./ast/ddl-nodes.ts"
import type { ASTNode, ExpressionNode, SelectNode, SubqueryNode } from "./ast/nodes.ts"
import type { TclNode } from "./ast/tcl-nodes.ts"
import type { Expression } from "./ast/typed-expression.ts"
import { AlterTableBuilder } from "./builder/ddl/alter-table.ts"
import { CreateIndexBuilder } from "./builder/ddl/create-index.ts"
import { CreateTableBuilder } from "./builder/ddl/create-table.ts"
import { CreateViewBuilder } from "./builder/ddl/create-view.ts"
import {
  DropIndexBuilder,
  DropTableBuilder,
  DropViewBuilder,
  TruncateTableBuilder,
} from "./builder/ddl/drop.ts"
import { CreateSchemaBuilder, DropSchemaBuilder } from "./builder/ddl/schema.ts"
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
import { MissingDriverError } from "./driver/execute.ts"
import { runInTransaction } from "./driver/transaction.ts"
import type { TransactionOptions } from "./driver/transaction.ts"
import type { Driver, ExecuteResult, Row } from "./driver/types.ts"
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
import type { SelectRow } from "./schema/types.ts"
import type { CompiledQuery, SQLDialect } from "./types.ts"

/**
 * Tables config constraint.
 * Each table = Record of ColumnBuilder instances.
 */
type TablesConfig = Record<string, Record<string, ColumnBuilder<any, any, any>>>

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
export function sumak<T extends TablesConfig>(config: SumakConfig<T>): Sumak<T> {
  return new Sumak(config.dialect, config.plugins ?? [], config.tables, {
    normalize: config.normalize,
    optimizeQueries: config.optimizeQueries,
    rules: config.rules,
    driver: config.driver,
  })
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
  /** @internal */
  _tables: Record<string, Record<string, ColumnBuilder<any, any, any>>>

  constructor(
    dialect: Dialect,
    plugins: SumakPlugin[] = [],
    tables: Record<string, Record<string, ColumnBuilder<any, any, any>>> = {},
    pipelineOpts: {
      normalize?: boolean | NormalizeOptions
      optimizeQueries?: boolean | OptimizeOptions
      rules?: RewriteRule[]
      driver?: Driver
    } = {},
  ) {
    this._dialect = dialect
    this._pluginsList = [...plugins]
    this._plugins = new PluginManager(plugins)
    this._hooks = new Hookable()
    this._tables = tables
    this._driver = pipelineOpts.driver
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
   * Like {@link driver} but returns `undefined` instead of throwing.
   * Useful for code paths that optionally execute.
   */
  driverOrNull(): Driver | undefined {
    return this._driver
  }

  /**
   * Run an already-compiled query through the configured driver and
   * apply `result:transform` plugins + hooks to the rows. Thin
   * convenience on top of `driver().query(sql, params)` that closes the
   * loop with sumak's result pipeline.
   */
  async executeCompiled(query: CompiledQuery): Promise<Row[]> {
    const driver = this.driver()
    const rows = await driver.query(query.sql, query.params)
    return this.transformResult(rows) as Row[]
  }

  /**
   * Fire-and-forget variant: run a compiled statement that returns no
   * rows (INSERT/UPDATE/DELETE without RETURNING, DDL, TCL). Returns
   * `{ affected: number }`.
   */
  async executeCompiledNoRows(query: CompiledQuery): Promise<ExecuteResult> {
    return this.driver().execute(query.sql, query.params)
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
        })
        // Inherit registered hooks on the scoped instance so the tx
        // block sees the same `result:transform` / `query:before` wiring
        // the parent does.
        scopedDb._hooks = this._hooks
        return fn(scopedDb)
      },
      opts,
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
          if (def.isUnique) col = col.unique()
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
  "truncate_table",
  "create_schema",
  "drop_schema",
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

  truncateTable(table: string, schema?: string): TruncateTableBuilder {
    return new TruncateTableBuilder(table, schema)
  }

  createSchema(name: string): CreateSchemaBuilder {
    return new CreateSchemaBuilder(name)
  }

  dropSchema(name: string): DropSchemaBuilder {
    return new DropSchemaBuilder(name)
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
