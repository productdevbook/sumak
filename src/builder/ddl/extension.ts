import type { CreateExtensionNode, DropExtensionNode } from "../../ast/ddl-nodes.ts"

/**
 * Builder for `CREATE EXTENSION [IF NOT EXISTS] name
 *   [ WITH ] [ SCHEMA schema ] [ VERSION 'version' ] [ CASCADE ]`.
 *
 * ```ts
 * db.schema.createExtension("btree_gist").ifNotExists().build()
 * // CREATE EXTENSION IF NOT EXISTS "btree_gist"
 *
 * db.schema.createExtension("pg_trgm").schema("public").cascade().build()
 * // CREATE EXTENSION "pg_trgm" SCHEMA "public" CASCADE
 *
 * db.schema.createExtension("postgis").version("3.4.2").build()
 * // CREATE EXTENSION "postgis" VERSION '3.4.2'
 * ```
 *
 * PostgreSQL-only. MySQL / SQLite / MSSQL have no equivalent grammar
 * and the printer refuses with {@link UnsupportedDialectFeatureError}.
 */
export class CreateExtensionBuilder {
  private _node: CreateExtensionNode

  constructor(name: string) {
    this._node = { type: "create_extension", name }
  }

  ifNotExists(): CreateExtensionBuilder {
    return this._clone({ ...this._node, ifNotExists: true })
  }

  schema(name: string): CreateExtensionBuilder {
    return this._clone({ ...this._node, schema: name })
  }

  version(v: string): CreateExtensionBuilder {
    return this._clone({ ...this._node, version: v })
  }

  cascade(): CreateExtensionBuilder {
    return this._clone({ ...this._node, cascade: true })
  }

  private _clone(node: CreateExtensionNode): CreateExtensionBuilder {
    const b = new CreateExtensionBuilder(node.name)
    b._node = node
    return b
  }

  build(): CreateExtensionNode {
    return this._node
  }
}

/**
 * Builder for `DROP EXTENSION [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`.
 *
 * Accepts either a single name or an array — PostgreSQL allows a
 * comma-separated list, so the AST and printer preserve that. `CASCADE`
 * and `RESTRICT` are mutually exclusive; calling both flips the most
 * recently set one (the builder doesn't try to be clever about it).
 *
 * ```ts
 * db.schema.dropExtension("btree_gist").ifExists().build()
 * // DROP EXTENSION IF EXISTS "btree_gist"
 *
 * db.schema.dropExtension(["uuid-ossp", "pgcrypto"]).cascade().build()
 * // DROP EXTENSION "uuid-ossp", "pgcrypto" CASCADE
 * ```
 *
 * PostgreSQL-only. MySQL / SQLite / MSSQL have no equivalent grammar
 * and the printer refuses with {@link UnsupportedDialectFeatureError}.
 */
export class DropExtensionBuilder {
  private _node: DropExtensionNode

  constructor(name: string | string[]) {
    const names = Array.isArray(name) ? [...name] : [name]
    this._node = { type: "drop_extension", names }
  }

  ifExists(): DropExtensionBuilder {
    return this._clone({ ...this._node, ifExists: true })
  }

  cascade(): DropExtensionBuilder {
    // `CASCADE` and `RESTRICT` are mutually exclusive in PG. Clear the
    // other flag rather than have the printer reject the combination —
    // the most recently called wins.
    const next: DropExtensionNode = { ...this._node, cascade: true }
    delete next.restrict
    return this._clone(next)
  }

  restrict(): DropExtensionBuilder {
    const next: DropExtensionNode = { ...this._node, restrict: true }
    delete next.cascade
    return this._clone(next)
  }

  private _clone(node: DropExtensionNode): DropExtensionBuilder {
    const b = new DropExtensionBuilder(node.names)
    b._node = node
    return b
  }

  build(): DropExtensionNode {
    return this._node
  }
}
