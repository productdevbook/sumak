import type {
  AlterTypeAddValueNode,
  AlterTypeRenameNode,
  AlterTypeRenameValueNode,
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

/**
 * Immutable builder for {@link AlterTypeAddValueNode} — PostgreSQL
 * `ALTER TYPE <name> ADD VALUE [IF NOT EXISTS] '<v>'
 *   [BEFORE | AFTER '<existing>']`.
 *
 * Extends a previously-created enum type with a new label. Without
 * `.before(...)` / `.after(...)` the new label is appended to the end of
 * the declared order (which is also the sort order on PG, so this is
 * almost always the right default for new states added over time).
 *
 * ```ts
 * db.schema.alterTypeAddValue("order_status").value("refunded").build()
 * // ALTER TYPE "order_status" ADD VALUE 'refunded'
 *
 * db.schema
 *   .alterTypeAddValue("order_status")
 *   .value("processing")
 *   .after("paid")
 *   .ifNotExists()
 *   .build()
 * // ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'processing' AFTER 'paid'
 * ```
 *
 * **Important PG quirk**: this statement is incompatible with normal
 * transactional migration tooling. In PG 11 and earlier it cannot run
 * inside a transaction block at all. PG 12+ permits it inside a
 * transaction, but the newly-added value isn't visible to *that* same
 * transaction (and multiple ADD VALUE statements on the same enum
 * within a single transaction are still rejected). Best practice:
 * emit each `ALTER TYPE … ADD VALUE` as its own standalone migration
 * step, then use the new label in a *subsequent* step.
 *
 * PostgreSQL-only. The printer refuses on MySQL / SQLite / MSSQL with
 * {@link UnsupportedDialectFeatureError} (the `CUSTOM_TYPES` feature
 * flag, shared with `CREATE TYPE AS ENUM`).
 */
export class AlterTypeAddValueBuilder {
  private readonly _node: AlterTypeAddValueNode

  constructor(name: string)
  constructor(node: AlterTypeAddValueNode)
  constructor(nameOrNode: string | AlterTypeAddValueNode) {
    if (typeof nameOrNode === "string") {
      // `value` is required at print time. Builders that ship without
      // it surface the same diagnostic shape as `CreateDomainBuilder`'s
      // missing-dataType case — empty string is the seed.
      this._node = { type: "alter_type_add_value", name: nameOrNode, value: "" }
    } else {
      this._node = nameOrNode
    }
  }

  private _clone(patch: Partial<AlterTypeAddValueNode>): AlterTypeAddValueBuilder {
    return new AlterTypeAddValueBuilder({ ...this._node, ...patch })
  }

  /**
   * Set the new label to add. Required — the printer throws if it's left
   * empty. Single quotes inside the value are doubled at print time so
   * a label like `O'Brien` is safe to splice into the SQL literal slot.
   */
  value(v: string): AlterTypeAddValueBuilder {
    return this._clone({ value: v })
  }

  /**
   * Emit `IF NOT EXISTS` (PG 9.6+). Makes the statement idempotent —
   * if the label already exists on the enum, PG treats the statement
   * as a no-op rather than raising a duplicate-value error. Strongly
   * recommended for migrations that may be re-run against a partially
   * upgraded database.
   */
  ifNotExists(): AlterTypeAddValueBuilder {
    return this._clone({ ifNotExists: true })
  }

  /**
   * Position the new label `BEFORE` the named existing label. Mutually
   * exclusive with {@link after} — last call wins, the previous position
   * is discarded.
   *
   * The existing label is doubled-quoted at print time the same way
   * the new value is.
   */
  before(existing: string): AlterTypeAddValueBuilder {
    return this._clone({ position: { kind: "BEFORE", existing } })
  }

  /**
   * Position the new label `AFTER` the named existing label. Mutually
   * exclusive with {@link before} — last call wins.
   */
  after(existing: string): AlterTypeAddValueBuilder {
    return this._clone({ position: { kind: "AFTER", existing } })
  }

  build(): AlterTypeAddValueNode {
    return { ...this._node }
  }
}

/**
 * Factory for {@link AlterTypeAddValueBuilder}.
 *
 * ```ts
 * alterTypeAddValue("order_status").value("refunded").after("shipped").build()
 * ```
 */
export function alterTypeAddValue(name: string): AlterTypeAddValueBuilder {
  return new AlterTypeAddValueBuilder(name)
}

/**
 * Immutable builder for {@link AlterTypeRenameNode} — PostgreSQL
 * `ALTER TYPE <name> RENAME TO <new_name>`.
 *
 * Renames a custom type in place. Every column, function, and cast
 * that references the type continues to work — PG resolves these by
 * OID, not by textual name. The rename is purely catalog-level (a
 * single tuple update on `pg_type`) and fully transactional.
 *
 * ```ts
 * db.schema.alterTypeRename("order_status", "order_state").build()
 * // ALTER TYPE "order_status" RENAME TO "order_state"
 *
 * // Or the chained form — `.to()` overrides the constructor-supplied
 * // target so a caller can stage the rename target separately.
 * db.schema.alterTypeRename("order_status").to("order_state").build()
 * ```
 *
 * Both names go through `validateFunctionName` at print time — any
 * non-identifier shape (with embedded SQL, spaces, etc.) is rejected
 * with a {@link SecurityError}.
 *
 * PostgreSQL-only. The printer refuses on MySQL / SQLite / MSSQL with
 * {@link UnsupportedDialectFeatureError} (the `CUSTOM_TYPES` feature
 * flag, shared with `CREATE TYPE AS ENUM`).
 */
export class AlterTypeRenameBuilder {
  private readonly _node: AlterTypeRenameNode

  constructor(name: string, newName?: string)
  constructor(node: AlterTypeRenameNode)
  constructor(nameOrNode: string | AlterTypeRenameNode, newName?: string) {
    if (typeof nameOrNode === "string") {
      // `newName` is required at print time. When omitted at
      // construction the builder seeds an empty string; the printer
      // refuses to emit an empty target name and points at `.to(...)`.
      this._node = {
        type: "alter_type_rename",
        name: nameOrNode,
        newName: newName ?? "",
      }
    } else {
      this._node = nameOrNode
    }
  }

  private _clone(patch: Partial<AlterTypeRenameNode>): AlterTypeRenameBuilder {
    return new AlterTypeRenameBuilder({ ...this._node, ...patch })
  }

  /**
   * Set (or override) the target name. Useful when the factory was
   * called without the new name — `alterTypeRename("foo").to("bar")` —
   * or when the target name is computed late.
   */
  to(newName: string): AlterTypeRenameBuilder {
    return this._clone({ newName })
  }

  build(): AlterTypeRenameNode {
    return { ...this._node }
  }
}

/**
 * Factory for {@link AlterTypeRenameBuilder}. The new name can be
 * supplied directly here for the common one-line case, or deferred via
 * `.to(...)` when staging the rename target separately.
 *
 * ```ts
 * alterTypeRename("order_status", "order_state").build()
 * // or
 * alterTypeRename("order_status").to("order_state").build()
 * ```
 */
export function alterTypeRename(name: string, newName?: string): AlterTypeRenameBuilder {
  return new AlterTypeRenameBuilder(name, newName)
}

/**
 * Immutable builder for {@link AlterTypeRenameValueNode} — PostgreSQL
 * `ALTER TYPE <name> RENAME VALUE '<old>' TO '<new>'`.
 *
 * Renames a single label on an existing enum type (PG 10+). Stored
 * rows keep their representation across the rename — enum values are
 * stored by OID, not by label text — so this is a pure catalog
 * operation with no table rewrite.
 *
 * ```ts
 * db.schema.alterTypeRenameValue("order_status").from("paid").to("captured").build()
 * // ALTER TYPE "order_status" RENAME VALUE 'paid' TO 'captured'
 * ```
 *
 * Unlike `ADD VALUE`, there is no `IF NOT EXISTS` clause — PG raises
 * if the old label is missing or if the new label already exists. The
 * statement is fully transactional and safe to batch with other DDL
 * inside a migration.
 *
 * Both label strings are escaped through `escapeStringLiteral` at
 * print time. The type name flows through `validateFunctionName`.
 *
 * PostgreSQL-only. The printer refuses on MySQL / SQLite / MSSQL with
 * {@link UnsupportedDialectFeatureError}.
 */
export class AlterTypeRenameValueBuilder {
  private readonly _node: AlterTypeRenameValueNode

  constructor(name: string)
  constructor(node: AlterTypeRenameValueNode)
  constructor(nameOrNode: string | AlterTypeRenameValueNode) {
    if (typeof nameOrNode === "string") {
      // Both label fields are required at print time; seed with empty
      // strings and let the printer refuse if either is left unset.
      this._node = {
        type: "alter_type_rename_value",
        name: nameOrNode,
        oldValue: "",
        newValue: "",
      }
    } else {
      this._node = nameOrNode
    }
  }

  private _clone(patch: Partial<AlterTypeRenameValueNode>): AlterTypeRenameValueBuilder {
    return new AlterTypeRenameValueBuilder({ ...this._node, ...patch })
  }

  /**
   * Set the existing label to rename. Required — the printer throws if
   * left empty. Single quotes inside the label are doubled at print
   * time so a label like `O'Brien` is safe to splice in.
   */
  from(oldValue: string): AlterTypeRenameValueBuilder {
    return this._clone({ oldValue })
  }

  /**
   * Set the new label name. Required — the printer throws if left
   * empty. Escaped the same way as `from()`.
   */
  to(newValue: string): AlterTypeRenameValueBuilder {
    return this._clone({ newValue })
  }

  build(): AlterTypeRenameValueNode {
    return { ...this._node }
  }
}

/**
 * Factory for {@link AlterTypeRenameValueBuilder}.
 *
 * ```ts
 * alterTypeRenameValue("order_status").from("paid").to("captured").build()
 * ```
 */
export function alterTypeRenameValue(name: string): AlterTypeRenameValueBuilder {
  return new AlterTypeRenameValueBuilder(name)
}
