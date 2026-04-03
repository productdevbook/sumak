import type { Dialect } from "./dialect/types.ts";
import type { ColumnBuilder } from "./schema/column.ts";
import type { ColumnType, SelectType } from "./schema/types.ts";
import { SelectBuilder } from "./builder/select.ts";
import { TypedSelectBuilder } from "./builder/typed-select.ts";
import { TypedInsertBuilder } from "./builder/typed-insert.ts";
import { TypedUpdateBuilder } from "./builder/typed-update.ts";
import { TypedDeleteBuilder } from "./builder/typed-delete.ts";
import type { ASTNode } from "./ast/nodes.ts";
import type { CompiledQuery } from "./types.ts";
import type { LalePlugin } from "./plugin/types.ts";
import { PluginManager } from "./plugin/plugin-manager.ts";
import { Hookable } from "./plugin/hooks.ts";
import type { HookName, LaleHooks } from "./plugin/hooks.ts";

/**
 * Extract the DB type from a tables config object.
 */
type InferDB<T extends Record<string, Record<string, ColumnBuilder<any, any, any>>>> = {
  [Table in keyof T]: {
    [Col in keyof T[Table]]: T[Table][Col] extends ColumnBuilder<infer S, infer I, infer U>
      ? ColumnType<S, I, U>
      : never;
  };
};

export interface LaleConfig<
  T extends Record<string, Record<string, ColumnBuilder<any, any, any>>>,
> {
  dialect: Dialect;
  tables: T;
  plugins?: LalePlugin[];
}

/**
 * Create a fully typed lale instance. DB type is inferred automatically.
 *
 * ```ts
 * const db = lale({
 *   dialect: pgDialect(),
 *   tables: {
 *     users: { id: serial(), name: text().notNull() },
 *   },
 * });
 *
 * // Hook into the query lifecycle
 * db.hook("select:before", (ctx) => {
 *   console.log("Selecting from:", ctx.table);
 * });
 *
 * db.selectFrom("users").select("id", "name")...
 * ```
 */
export function lale<T extends Record<string, Record<string, ColumnBuilder<any, any, any>>>>(
  config: LaleConfig<T>,
): Lale<InferDB<T>> {
  return new Lale(config.dialect, config.plugins ?? []);
}

/**
 * Core lale instance with hook system.
 */
export class Lale<DB> {
  private _dialect: Dialect;
  private _plugins: PluginManager;
  private _hooks: Hookable;

  constructor(dialect: Dialect, plugins: LalePlugin[] = []) {
    this._dialect = dialect;
    this._plugins = new PluginManager(plugins);
    this._hooks = new Hookable();
  }

  /**
   * Register a hook handler. Returns an unregister function.
   *
   * ```ts
   * const off = db.hook("query:before", (ctx) => { ... });
   * off(); // unregister
   * ```
   */
  hook<K extends HookName>(name: K, handler: LaleHooks[K]): () => void {
    return this._hooks.hook(name, handler);
  }

  selectFrom<T extends keyof DB & string>(
    table: T,
    alias?: string,
  ): TypedSelectBuilder<DB, T, { [K in keyof DB[T]]: SelectType<DB[T][K]> }> {
    return new TypedSelectBuilder(new SelectBuilder().from(table, alias));
  }

  insertInto<T extends keyof DB & string>(table: T): TypedInsertBuilder<DB, T> {
    return new TypedInsertBuilder<DB, T>(table);
  }

  update<T extends keyof DB & string>(table: T): TypedUpdateBuilder<DB, T> {
    return new TypedUpdateBuilder<DB, T>(table);
  }

  deleteFrom<T extends keyof DB & string>(table: T): TypedDeleteBuilder<DB, T> {
    return new TypedDeleteBuilder<DB, T>(table);
  }

  /**
   * Compile an AST node through the full pipeline:
   * plugins.transformNode → type-specific hooks → printer → plugins.transformQuery → query hooks
   */
  compile(node: ASTNode): CompiledQuery {
    // 1. Plugin AST transform
    let ast = this._plugins.transformNode(node);

    // 2. Type-specific before hooks
    const table = this._extractTableName(ast);
    switch (ast.type) {
      case "select": {
        const result = this._hooks.callHook("select:before", { node: ast, table });
        if (result) ast = result;
        break;
      }
      case "insert": {
        const result = this._hooks.callHook("insert:before", { node: ast, table });
        if (result) ast = result;
        break;
      }
      case "update": {
        const result = this._hooks.callHook("update:before", { node: ast, table });
        if (result) ast = result;
        break;
      }
      case "delete": {
        const result = this._hooks.callHook("delete:before", { node: ast, table });
        if (result) ast = result;
        break;
      }
    }

    // 3. Generic before hook
    const beforeResult = this._hooks.callHook("query:before", { node: ast, table });
    if (beforeResult) ast = beforeResult;

    // 4. Print to SQL
    const printer = this._dialect.createPrinter();
    let query = printer.print(ast);

    // 5. Plugin query transform
    query = this._plugins.transformQuery(query);

    // 6. After hook
    const afterResult = this._hooks.callHook("query:after", { node: ast, table, query });
    if (afterResult) query = afterResult;

    return query;
  }

  /**
   * Transform result rows through plugins and hooks.
   */
  transformResult(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    let result = this._plugins.transformResult(rows);
    const hookResult = this._hooks.callHook("result:transform", result);
    if (hookResult) result = hookResult;
    return result;
  }

  printer() {
    return this._dialect.createPrinter();
  }

  private _extractTableName(node: ASTNode): string | undefined {
    switch (node.type) {
      case "select":
        return node.from?.type === "table_ref" ? node.from.name : undefined;
      case "insert":
        return node.table.name;
      case "update":
        return node.table.name;
      case "delete":
        return node.table.name;
      default:
        return undefined;
    }
  }
}
