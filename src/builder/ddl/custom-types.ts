import type {
  CreateDomainNode,
  CreateTypeEnumNode,
  DropDomainNode,
  DropTypeNode,
} from "../../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../../ast/nodes.ts"
import type { Expression } from "../../ast/typed-expression.ts"

/**
 * Accept either a typed `Expression<T>` wrapper (the runtime shape
 * returned by `sql\`...\``) or a raw `ExpressionNode`. Returns the
 * underlying node. Mirrors the `CreateIndexBuilder.where()` /
 * `CreatePolicyBuilder.using()` lowering pattern so domain CHECK and
 * DEFAULT expressions accept the same surface.
 */
function unwrapExpression<T>(expr: ExpressionNode | Expression<T>): ExpressionNode {
  const maybeWrapper = expr as { node?: ExpressionNode }
  return maybeWrapper.node ?? (expr as ExpressionNode)
}

/**
 * Immutable builder for {@link CreateTypeEnumNode} — PostgreSQL
 * `CREATE TYPE <name> AS ENUM ('v1', 'v2', ...)`.
 *
 * Unlike the inline `enumType()` column helper (which embeds an
 * `enum(...)` shape into a single column), this creates a *named*
 * type usable across many tables and functions. The declared label
 * order is also the sort order — `ORDER BY status` orders by the
 * enum's declared sequence, not lexicographic text.
 *
 * ```ts
 * db.schema.createTypeEnum("order_status").values("pending", "paid", "shipped").build()
 * // CREATE TYPE "order_status" AS ENUM ('pending', 'paid', 'shipped')
 *
 * // The values can also be passed as an array — useful when sourcing
 * // them from a const tuple typed in TS.
 * db.schema.createTypeEnum("mood").values(["happy", "sad", "ok"]).build()
 * ```
 *
 * PostgreSQL-only. MySQL only has the inline column shape; SQLite has
 * no enum; MSSQL's `CREATE TYPE` is a completely different form. The
 * printer refuses on every non-PG dialect with
 * {@link UnsupportedDialectFeatureError}.
 */
export class CreateTypeEnumBuilder {
  private _node: CreateTypeEnumNode

  constructor(name: string)
  constructor(node: CreateTypeEnumNode)
  constructor(nameOrNode: string | CreateTypeEnumNode) {
    if (typeof nameOrNode === "string") {
      this._node = { type: "create_type_enum", name: nameOrNode, values: [] }
    } else {
      this._node = { ...nameOrNode, values: [...nameOrNode.values] }
    }
  }

  /**
   * Set the enum's label list. Accepts either a rest list of strings or
   * a single string array — both are equivalent. Each call *replaces*
   * the previous list (the chain is idempotent), so accumulating
   * values across multiple `.values()` calls is intentional in this
   * builder's design.
   *
   * The declared order matters: PG uses it as the sort order for
   * `ORDER BY` on enum-typed columns. Empty arrays are allowed (PG
   * accepts `CREATE TYPE name AS ENUM ()`) but rarely useful.
   */
  values(...args: [string[]] | string[]): CreateTypeEnumBuilder {
    const values = args.length === 1 && Array.isArray(args[0]) ? [...args[0]] : (args as string[])
    return this._clone({ ...this._node, values })
  }

  private _clone(node: CreateTypeEnumNode): CreateTypeEnumBuilder {
    return new CreateTypeEnumBuilder(node)
  }

  build(): CreateTypeEnumNode {
    return { ...this._node, values: [...this._node.values] }
  }
}

/**
 * Factory for {@link CreateTypeEnumBuilder}.
 *
 * ```ts
 * createTypeEnum("status").values("a", "b").build()
 * ```
 */
export function createTypeEnum(name: string): CreateTypeEnumBuilder {
  return new CreateTypeEnumBuilder(name)
}

/**
 * Immutable builder for {@link DropTypeNode} — PostgreSQL
 * `DROP TYPE [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`.
 *
 * Accepts either a single name or an array — PostgreSQL allows a
 * comma-separated list, so the AST and printer preserve that.
 * `CASCADE` and `RESTRICT` are mutually exclusive; calling both flips
 * the most recently set one (the builder doesn't try to be clever
 * about it — last call wins).
 *
 * ```ts
 * db.schema.dropType("order_status").ifExists().build()
 * // DROP TYPE IF EXISTS "order_status"
 *
 * db.schema.dropType(["mood", "status"]).cascade().build()
 * // DROP TYPE "mood", "status" CASCADE
 * ```
 *
 * PostgreSQL-only. The printer refuses on MySQL / SQLite / MSSQL with
 * {@link UnsupportedDialectFeatureError}.
 */
export class DropTypeBuilder {
  private _node: DropTypeNode

  constructor(name: string | string[]) {
    const names = Array.isArray(name) ? [...name] : [name]
    this._node = { type: "drop_type", names }
  }

  ifExists(): DropTypeBuilder {
    return this._clone({ ...this._node, ifExists: true })
  }

  cascade(): DropTypeBuilder {
    // `CASCADE` and `RESTRICT` are mutually exclusive in PG. Clear the
    // other flag rather than have the printer reject the combination —
    // last call wins.
    const next: DropTypeNode = { ...this._node, cascade: true }
    delete next.restrict
    return this._clone(next)
  }

  restrict(): DropTypeBuilder {
    const next: DropTypeNode = { ...this._node, restrict: true }
    delete next.cascade
    return this._clone(next)
  }

  private _clone(node: DropTypeNode): DropTypeBuilder {
    const b = new DropTypeBuilder(node.names)
    b._node = node
    return b
  }

  build(): DropTypeNode {
    return { ...this._node, names: [...this._node.names] }
  }
}

/**
 * Factory for {@link DropTypeBuilder}.
 */
export function dropType(name: string | string[]): DropTypeBuilder {
  return new DropTypeBuilder(name)
}

/**
 * Immutable builder for {@link CreateDomainNode} — PostgreSQL
 * `CREATE DOMAIN <name> AS <base_type>
 *   [DEFAULT <expr>]
 *   [[CONSTRAINT <cname>] { NOT NULL | CHECK (<expr>) }]`.
 *
 * Quick reference:
 *
 *  - `.dataType(type)` — required; the underlying base type. Can be
 *    supplied in the constructor too: `createDomain("name", "integer")`.
 *  - `.defaultTo(expr)` — `DEFAULT <expr>` clause.
 *  - `.notNull()` — emit a `NOT NULL` constraint on the domain. In PG
 *    this is a separate constraint kind from the column-level NOT NULL.
 *  - `.check(expr, name?)` — `CHECK (<expr>)`, with an optional
 *    `CONSTRAINT <name>` prefix. Inside the expression, `VALUE` refers
 *    to the value being checked — write that via
 *    `sql\`VALUE > 0\``.
 *
 * ```ts
 * createDomain("positive_int", "integer")
 *   .notNull()
 *   .check(sql<boolean>`VALUE > 0`, "positive_int_check")
 *   .build()
 * // CREATE DOMAIN "positive_int" AS integer
 * //   NOT NULL CONSTRAINT "positive_int_check" CHECK ((VALUE > 0))
 * ```
 *
 * PostgreSQL-only. The printer refuses on MySQL / SQLite / MSSQL with
 * {@link UnsupportedDialectFeatureError}.
 */
export class CreateDomainBuilder {
  private readonly _node: CreateDomainNode

  constructor(name: string, dataType?: string)
  constructor(node: CreateDomainNode)
  constructor(nameOrNode: string | CreateDomainNode, dataType?: string) {
    if (typeof nameOrNode === "string") {
      this._node = {
        type: "create_domain",
        name: nameOrNode,
        // `dataType` is required at print time; left empty until
        // `.dataType()` runs (or the constructor supplied it).
        dataType: dataType ?? "",
      }
    } else {
      this._node = nameOrNode
    }
  }

  private _clone(patch: Partial<CreateDomainNode>): CreateDomainBuilder {
    return new CreateDomainBuilder({ ...this._node, ...patch })
  }

  /**
   * Set the domain's underlying type (e.g. `"integer"`, `"text"`,
   * `"varchar(120)"`). Validated by `validateDataType` at print time.
   */
  dataType(type: string): CreateDomainBuilder {
    return this._clone({ dataType: type })
  }

  /**
   * `DEFAULT <expr>` — accepts either a typed `Expression<T>` wrapper
   * (e.g. `sql\`0\``) or a raw `ExpressionNode`. Renders through the
   * DDL expression printer (same surface as a CHECK clause).
   */
  defaultTo<T>(expr: ExpressionNode | Expression<T>): CreateDomainBuilder {
    return this._clone({ defaultExpression: unwrapExpression(expr) })
  }

  /**
   * Emit `NOT NULL` on the domain. PG treats this as a separate
   * constraint kind from the column-level NOT NULL — it applies to
   * every column declared with the domain type.
   */
  notNull(): CreateDomainBuilder {
    return this._clone({ notNull: true })
  }

  /**
   * `[CONSTRAINT <name>] CHECK (<expr>)` — the central use case for a
   * domain. The expression typically references `VALUE` (a magic
   * identifier in PG that refers to the value being checked); write
   * it as `sql\`VALUE > 0\`` or any other expression form.
   *
   * Passing a `name` adds the optional `CONSTRAINT <name>` prefix,
   * which makes the constraint addressable later for `ALTER DOMAIN
   * <d> DROP CONSTRAINT <name>` etc.
   */
  check(expr: ExpressionNode | Expression<boolean>, name?: string): CreateDomainBuilder {
    return this._clone({
      check: unwrapExpression(expr),
      checkConstraintName: name,
    })
  }

  build(): CreateDomainNode {
    return { ...this._node }
  }
}

/**
 * Factory for {@link CreateDomainBuilder}.
 *
 * ```ts
 * createDomain("positive_int", "integer").check(sql`VALUE > 0`).build()
 * ```
 */
export function createDomain(name: string, dataType?: string): CreateDomainBuilder {
  return new CreateDomainBuilder(name, dataType)
}

/**
 * Immutable builder for {@link DropDomainNode} — PostgreSQL
 * `DROP DOMAIN [IF EXISTS] name [, ...] [CASCADE | RESTRICT]`.
 *
 * Same shape as {@link DropTypeBuilder} — comma-separated list, plus
 * mutually-exclusive `CASCADE` / `RESTRICT` flags handled the same
 * "last call wins" way.
 *
 * ```ts
 * db.schema.dropDomain("positive_int").ifExists().build()
 * // DROP DOMAIN IF EXISTS "positive_int"
 * ```
 *
 * PostgreSQL-only. The printer refuses on MySQL / SQLite / MSSQL with
 * {@link UnsupportedDialectFeatureError}.
 */
export class DropDomainBuilder {
  private _node: DropDomainNode

  constructor(name: string | string[]) {
    const names = Array.isArray(name) ? [...name] : [name]
    this._node = { type: "drop_domain", names }
  }

  ifExists(): DropDomainBuilder {
    return this._clone({ ...this._node, ifExists: true })
  }

  cascade(): DropDomainBuilder {
    const next: DropDomainNode = { ...this._node, cascade: true }
    delete next.restrict
    return this._clone(next)
  }

  restrict(): DropDomainBuilder {
    const next: DropDomainNode = { ...this._node, restrict: true }
    delete next.cascade
    return this._clone(next)
  }

  private _clone(node: DropDomainNode): DropDomainBuilder {
    const b = new DropDomainBuilder(node.names)
    b._node = node
    return b
  }

  build(): DropDomainNode {
    return { ...this._node, names: [...this._node.names] }
  }
}

/**
 * Factory for {@link DropDomainBuilder}.
 */
export function dropDomain(name: string | string[]): DropDomainBuilder {
  return new DropDomainBuilder(name)
}
