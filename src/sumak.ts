import type { ASTNode } from "./ast/nodes.ts"
import type { Expression } from "./ast/typed-expression.ts"
import { AlterTableBuilder } from "./builder/ddl/alter-table.ts"
import { CreateIndexBuilder } from "./builder/ddl/create-index.ts"
import { CreateTableBuilder } from "./builder/ddl/create-table.ts"
import { CreateViewBuilder } from "./builder/ddl/create-view.ts"
import { DropIndexBuilder, DropTableBuilder, DropViewBuilder } from "./builder/ddl/drop.ts"
import { Col } from "./builder/eb.ts"
import { SelectBuilder } from "./builder/select.ts"
import { TypedDeleteBuilder } from "./builder/typed-delete.ts"
import { TypedInsertBuilder } from "./builder/typed-insert.ts"
import { TypedMergeBuilder } from "./builder/typed-merge.ts"
import { TypedSelectBuilder } from "./builder/typed-select.ts"
import { TypedUpdateBuilder } from "./builder/typed-update.ts"
import type { Dialect } from "./dialect/types.ts"
import { Hookable } from "./plugin/hooks.ts"
import type { HookName, SumakHooks } from "./plugin/hooks.ts"
import { PluginManager } from "./plugin/plugin-manager.ts"
import type { SumakPlugin } from "./plugin/types.ts"
import { DDLPrinter } from "./printer/ddl.ts"
import type { Printer } from "./printer/types.ts"
import type { ColumnBuilder } from "./schema/column.ts"
import type { SelectRow } from "./schema/types.ts"
import type { CompiledQuery } from "./types.ts"

/**
 * Tables config constraint.
 * Each table = Record of ColumnBuilder instances.
 */
type TablesConfig = Record<string, Record<string, ColumnBuilder<any, any, any>>>

export interface SumakConfig<T extends TablesConfig> {
  dialect: Dialect
  tables: T
  plugins?: SumakPlugin[]
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
  return new Sumak(config.dialect, config.plugins ?? [], config.tables)
}

/**
 * Core sumak instance with hook system.
 */
export class Sumak<DB> {
  private _dialect: Dialect
  private _plugins: PluginManager
  private _hooks: Hookable
  /** @internal */
  _tables: Record<string, Record<string, ColumnBuilder<any, any, any>>>

  constructor(
    dialect: Dialect,
    plugins: SumakPlugin[] = [],
    tables: Record<string, Record<string, ColumnBuilder<any, any, any>>> = {},
  ) {
    this._dialect = dialect
    this._plugins = new PluginManager(plugins)
    this._hooks = new Hookable()
    this._tables = tables
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
    return new TypedSelectBuilder(new SelectBuilder().from(table, alias), table)
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
    subquery: { build(): import("./ast/nodes.ts").SelectNode },
    alias: Alias,
  ): TypedSelectBuilder<DB, keyof DB & string, Record<string, unknown>> {
    const sub: import("./ast/nodes.ts").SubqueryNode = {
      type: "subquery",
      query: subquery.build(),
      alias,
    }
    return new TypedSelectBuilder(new SelectBuilder().from(sub), alias as any)
  }

  insertInto<T extends keyof DB & string>(table: T): TypedInsertBuilder<DB, T> {
    return new TypedInsertBuilder<DB, T>(table)
  }

  update<T extends keyof DB & string>(table: T): TypedUpdateBuilder<DB, T> {
    return new TypedUpdateBuilder<DB, T>(table)
  }

  deleteFrom<T extends keyof DB & string>(table: T): TypedDeleteBuilder<DB, T> {
    return new TypedDeleteBuilder<DB, T>(table)
  }

  /**
   * MERGE INTO target USING source ON condition.
   *
   * ```ts
   * db.mergeInto("users", "staging", "s", ({ target, source }) =>
   *   target.id.eqCol(source.id),
   * )
   * .whenMatchedThenUpdate({ name: "updated" })
   * .whenNotMatchedThenInsert({ name: "new", email: "e@x.com" })
   * .compile(db.printer())
   * ```
   */
  mergeInto<T extends keyof DB & string, S extends keyof DB & string>(
    target: T,
    source: S,
    sourceAlias: string,
    on: (proxies: {
      target: { [K in keyof DB[T] & string]: Col<any> }
      source: { [K in keyof DB[S] & string]: Col<any> }
    }) => Expression<boolean>,
  ): TypedMergeBuilder<DB, T, S> {
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
      source: makeProxy(sourceAlias),
    } as any
    const onExpr = on(proxies)
    return new TypedMergeBuilder<DB, T, S>(target, source, sourceAlias, onExpr)
  }

  /**
   * Compile an AST node through the full pipeline:
   * plugins.transformNode → type-specific hooks → printer → plugins.transformQuery → query hooks
   */
  compile(node: ASTNode): CompiledQuery {
    // 1. Plugin AST transform
    let ast = this._plugins.transformNode(node)

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

    // 4. Print to SQL
    const printer = this._dialect.createPrinter()
    let query = printer.print(ast)

    // 5. Plugin query transform
    query = this._plugins.transformQuery(query)

    // 6. After hook
    const afterResult = this._hooks.callHook("query:after", { node: ast, table, query })
    if (afterResult) query = afterResult

    return query
  }

  /**
   * Transform result rows through plugins and hooks.
   */
  transformResult(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    let result = this._plugins.transformResult(rows)
    const hookResult = this._hooks.callHook("result:transform", result)
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
    const printer = new DDLPrinter(this._dialect.name)
    const results: CompiledQuery[] = []

    for (const [tableName, columns] of Object.entries(this._tables)) {
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
          if (def.references) col = col.references(def.references.table, def.references.column)
          return col
        })
      }

      results.push(printer.print(tb.build()))
    }
    return results
  }

  /** Compile a DDL node to SQL. */
  compileDDL(node: import("./ast/ddl-nodes.ts").DDLNode): CompiledQuery {
    const printer = new DDLPrinter(this._dialect.name)
    return printer.print(node)
  }

  private _extractTableName(node: ASTNode): string | undefined {
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
  private _dialect: import("./types.ts").SQLDialect

  constructor(dialect: import("./types.ts").SQLDialect) {
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
}
