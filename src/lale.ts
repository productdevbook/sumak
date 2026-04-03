import type { Dialect } from "./dialect/types.ts";
import type { SelectType } from "./schema/types.ts";
import { SelectBuilder } from "./builder/select.ts";
import { TypedSelectBuilder } from "./builder/typed-select.ts";
import { TypedInsertBuilder } from "./builder/typed-insert.ts";
import { TypedUpdateBuilder } from "./builder/typed-update.ts";
import { TypedDeleteBuilder } from "./builder/typed-delete.ts";
import type { ASTNode } from "./ast/nodes.ts";
import type { CompiledQuery } from "./types.ts";
import type { LalePlugin } from "./plugin/types.ts";
import { PluginManager } from "./plugin/plugin-manager.ts";

export interface LaleConfig {
  dialect: Dialect;
  plugins?: LalePlugin[];
}

/**
 * Main typed entry point for lale.
 *
 * ```ts
 * const db = new Lale<DB>({ dialect: pgDialect() });
 *
 * const query = db.selectFrom("users")
 *   .select("id", "name")
 *   .where(typedEq(typedCol<number>("id"), typedParam(0, 1)))
 *   .compile(db.printer());
 * ```
 */
export class Lale<DB> {
  private _dialect: Dialect;
  private _plugins: PluginManager;

  constructor(config: LaleConfig) {
    this._dialect = config.dialect;
    this._plugins = new PluginManager(config.plugins ?? []);
  }

  /**
   * Create a typed SELECT query builder.
   */
  selectFrom<T extends keyof DB & string>(
    table: T,
    alias?: string,
  ): TypedSelectBuilder<DB, T, { [K in keyof DB[T]]: SelectType<DB[T][K]> }> {
    const builder = new SelectBuilder().from(table, alias);
    return new TypedSelectBuilder(builder);
  }

  /**
   * Create a typed INSERT query builder.
   */
  insertInto<T extends keyof DB & string>(table: T): TypedInsertBuilder<DB, T> {
    return new TypedInsertBuilder<DB, T>(table);
  }

  /**
   * Create a typed UPDATE query builder.
   */
  update<T extends keyof DB & string>(table: T): TypedUpdateBuilder<DB, T> {
    return new TypedUpdateBuilder<DB, T>(table);
  }

  /**
   * Create a typed DELETE query builder.
   */
  deleteFrom<T extends keyof DB & string>(table: T): TypedDeleteBuilder<DB, T> {
    return new TypedDeleteBuilder<DB, T>(table);
  }

  /**
   * Compile an AST node to SQL, running through plugin pipeline.
   */
  compile(node: ASTNode): CompiledQuery {
    const transformed = this._plugins.transformNode(node);
    const printer = this._dialect.createPrinter();
    const query = printer.print(transformed);
    return this._plugins.transformQuery(query);
  }

  /**
   * Transform result rows through plugin pipeline.
   */
  transformResult(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return this._plugins.transformResult(rows);
  }

  /**
   * Get a printer for this dialect.
   */
  printer() {
    return this._dialect.createPrinter();
  }
}
