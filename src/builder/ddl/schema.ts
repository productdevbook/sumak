import type { CreateSchemaNode, DropSchemaNode } from "../../ast/ddl-nodes.ts"

/**
 * Builder for `CREATE SCHEMA name [IF NOT EXISTS] [AUTHORIZATION role]`.
 *
 * ```ts
 * db.schema.createSchema("audit").ifNotExists().build()
 * // CREATE SCHEMA IF NOT EXISTS "audit"
 *
 * db.schema.createSchema("tenant_42").authorization("app_user").build()
 * // CREATE SCHEMA "tenant_42" AUTHORIZATION "app_user"
 * ```
 */
export class CreateSchemaBuilder {
  private _node: CreateSchemaNode

  constructor(name: string) {
    this._node = { type: "create_schema", name }
  }

  ifNotExists(): CreateSchemaBuilder {
    return this._clone({ ...this._node, ifNotExists: true })
  }

  authorization(role: string): CreateSchemaBuilder {
    return this._clone({ ...this._node, authorization: role })
  }

  private _clone(node: CreateSchemaNode): CreateSchemaBuilder {
    const b = new CreateSchemaBuilder(node.name)
    b._node = node
    return b
  }

  build(): CreateSchemaNode {
    return this._node
  }
}

/**
 * Builder for `DROP SCHEMA [IF EXISTS] name [CASCADE]`.
 *
 * ```ts
 * db.schema.dropSchema("audit").ifExists().cascade().build()
 * // DROP SCHEMA IF EXISTS "audit" CASCADE
 * ```
 */
export class DropSchemaBuilder {
  private _node: DropSchemaNode

  constructor(name: string) {
    this._node = { type: "drop_schema", name }
  }

  ifExists(): DropSchemaBuilder {
    return this._clone({ ...this._node, ifExists: true })
  }

  cascade(): DropSchemaBuilder {
    return this._clone({ ...this._node, cascade: true })
  }

  private _clone(node: DropSchemaNode): DropSchemaBuilder {
    const b = new DropSchemaBuilder(node.name)
    b._node = node
    return b
  }

  build(): DropSchemaNode {
    return this._node
  }
}
