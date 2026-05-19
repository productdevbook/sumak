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
 * returned by `eb({...})` and `sql\`...\``) or a raw `ExpressionNode`.
 * Returns the underlying node. Same lowering used by the create-index
 * and policy builders.
 */
function unwrapExpr<T>(expr: ExpressionNode | Expression<T>): ExpressionNode {
  const maybeWrapper = expr as { node?: ExpressionNode }
  return maybeWrapper.node ?? (expr as ExpressionNode)
}

/**
 * Immutable builder for {@link CreateTypeEnumNode} — PostgreSQL
 * `CREATE TYPE <name> AS ENUM ('v1', 'v2', …)`.
 *
 * Two entry shapes:
 *
 *  - `createTypeEnum(name)` — empty value list; chain `.values(...)` to
 *    populate it.
 *  - `createTypeEnum(name, "v1", "v2", "v3")` — values inline.
 *
 * ```ts
 * createTypeEnum("mood").values("sad", "happy", "ecstatic").build()
 * // CREATE TYPE "mood" AS ENUM ('sad', 'happy', 'ecstatic')
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL at print time via `CUSTOM_TYPES` —
 * none of the three has a matching standalone `CREATE TYPE … AS ENUM`
 * shape. MySQL users wanting an enum should use the column-level
 * `ENUM(…)` type directly (no `CREATE TYPE` needed).
 */
export class CreateTypeEnumBuilder {
  private readonly node: CreateTypeEnumNode

  constructor(name: string, ...values: string[])
  constructor(node: CreateTypeEnumNode)
  constructor(nameOrNode: string | CreateTypeEnumNode, ...values: string[]) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "create_type_enum",
        name: nameOrNode,
        values: [...values],
      }
    } else {
      this.node = nameOrNode
    }
  }

  private clone(patch: Partial<CreateTypeEnumNode>): CreateTypeEnumBuilder {
    return new CreateTypeEnumBuilder({ ...this.node, ...patch })
  }

  /**
   * Replace the full value list. Variadic — pass each label as its own
   * argument. The order matters: PG sorts enum values by declaration
   * order, and that order survives `ORDER BY <enum_column>`.
   *
   * Calling `.values(...)` more than once replaces the previous list
   * (idempotent chain).
   */
  values(...vals: string[]): CreateTypeEnumBuilder {
    return this.clone({ values: [...vals] })
  }

  build(): CreateTypeEnumNode {
    return { ...this.node, values: [...this.node.values] }
  }
}

/**
 * Factory for {@link CreateTypeEnumBuilder}. Pass labels inline or chain
 * `.values(...)` to populate them.
 *
 * ```ts
 * createTypeEnum("mood", "sad", "happy", "ecstatic").build()
 * // CREATE TYPE "mood" AS ENUM ('sad', 'happy', 'ecstatic')
 *
 * createTypeEnum("mood").values("sad", "happy", "ecstatic").build()
 * // same
 * ```
 */
export function createTypeEnum(name: string, ...values: string[]): CreateTypeEnumBuilder {
  return new CreateTypeEnumBuilder(name, ...values)
}

/**
 * Immutable builder for {@link DropTypeNode} — PostgreSQL
 * `DROP TYPE [IF EXISTS] <name> [, <name> …] [CASCADE | RESTRICT]`.
 *
 * Single-name and multi-name forms:
 *
 * ```ts
 * dropType("mood").build()
 * // DROP TYPE "mood"
 *
 * dropType(["mood", "status"]).ifExists().cascade().build()
 * // DROP TYPE IF EXISTS "mood", "status" CASCADE
 * ```
 *
 * `cascade` and `restrict` are mutually exclusive — set only one; the
 * printer refuses if both are true. Refused on every non-PG dialect.
 */
export class DropTypeBuilder {
  private readonly node: DropTypeNode

  constructor(name: string | string[])
  constructor(node: DropTypeNode)
  constructor(nameOrNode: string | string[] | DropTypeNode) {
    if (typeof nameOrNode === "string") {
      this.node = { type: "drop_type", names: [nameOrNode] }
    } else if (Array.isArray(nameOrNode)) {
      this.node = { type: "drop_type", names: [...nameOrNode] }
    } else {
      this.node = nameOrNode
    }
  }

  private clone(patch: Partial<DropTypeNode>): DropTypeBuilder {
    return new DropTypeBuilder({ ...this.node, ...patch })
  }

  ifExists(): DropTypeBuilder {
    return this.clone({ ifExists: true })
  }

  cascade(): DropTypeBuilder {
    return this.clone({ cascade: true })
  }

  restrict(): DropTypeBuilder {
    return this.clone({ restrict: true })
  }

  build(): DropTypeNode {
    return { ...this.node, names: [...this.node.names] }
  }
}

/**
 * Factory for {@link DropTypeBuilder}. Accepts a single name or an
 * array of names for the multi-drop form.
 */
export function dropType(name: string | string[]): DropTypeBuilder {
  return new DropTypeBuilder(name)
}

/**
 * Immutable builder for {@link CreateDomainNode} — PostgreSQL
 * `CREATE DOMAIN <name> AS <type> [DEFAULT …] [[CONSTRAINT name]
 * NOT NULL | CHECK (…)]`.
 *
 *  - `.dataType(t)` — required. The wrapped SQL type (`text`,
 *    `varchar(50)`, `integer`, …). Validated through `validateDataType`
 *    at print time.
 *  - `.defaultTo(expr)` — `DEFAULT <expr>`. Accepts either a typed
 *    `Expression<T>` wrapper or a raw `ExpressionNode`.
 *  - `.notNull()` — `NOT NULL` constraint.
 *  - `.check(expr, name?)` — `CHECK (<expr>)` constraint. Optional
 *    `name` emits `CONSTRAINT <name> CHECK (…)`.
 *
 * The constructor accepts either just the domain name (`.dataType(...)`
 * supplied later) or both name + type for the inline form. Without a
 * data type set the printer throws — a domain without an underlying
 * type is a parse error.
 *
 * ```ts
 * createDomain("email").dataType("text").check(sql`value ~ '^[^@]+@[^@]+$'`).build()
 * // CREATE DOMAIN "email" AS text CHECK (value ~ '^[^@]+@[^@]+$')
 *
 * createDomain("positive_int", "integer").notNull().check(sql`value > 0`).build()
 * // CREATE DOMAIN "positive_int" AS integer NOT NULL CHECK (value > 0)
 * ```
 *
 * Refused on every non-PG dialect.
 */
export class CreateDomainBuilder {
  private readonly node: CreateDomainNode

  constructor(name: string, dataType?: string)
  constructor(node: CreateDomainNode)
  constructor(nameOrNode: string | CreateDomainNode, dataType?: string) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "create_domain",
        name: nameOrNode,
        // `dataType` is required at print time; left as empty string
        // when the constructor wasn't given one so `.dataType(...)` can
        // fill it in.
        dataType: dataType ?? "",
      }
    } else {
      this.node = nameOrNode
    }
  }

  private clone(patch: Partial<CreateDomainNode>): CreateDomainBuilder {
    return new CreateDomainBuilder({ ...this.node, ...patch })
  }

  dataType(t: string): CreateDomainBuilder {
    return this.clone({ dataType: t })
  }

  defaultTo<T>(expr: ExpressionNode | Expression<T>): CreateDomainBuilder {
    return this.clone({ defaultExpression: unwrapExpr(expr) })
  }

  notNull(): CreateDomainBuilder {
    return this.clone({ notNull: true })
  }

  /**
   * `CHECK (<expr>)` constraint. Pass an optional `name` to emit
   * `CONSTRAINT <name> CHECK (…)` — useful so a later `ALTER DOMAIN …
   * DROP CONSTRAINT <name>` has a stable identifier to target.
   */
  check<T>(expr: ExpressionNode | Expression<T>, name?: string): CreateDomainBuilder {
    return this.clone({
      check: unwrapExpr(expr),
      checkConstraintName: name,
    })
  }

  build(): CreateDomainNode {
    return { ...this.node }
  }
}

/**
 * Factory for {@link CreateDomainBuilder}.
 *
 * ```ts
 * createDomain("email").dataType("text").check(sql`value ~ '^[^@]+@[^@]+$'`).build()
 * // CREATE DOMAIN "email" AS text CHECK (value ~ '^[^@]+@[^@]+$')
 * ```
 */
export function createDomain(name: string, dataType?: string): CreateDomainBuilder {
  return new CreateDomainBuilder(name, dataType)
}

/**
 * Immutable builder for {@link DropDomainNode} — PostgreSQL
 * `DROP DOMAIN [IF EXISTS] <name> [, <name> …] [CASCADE | RESTRICT]`.
 * Mirrors {@link DropTypeBuilder} exactly; PG distinguishes DROP TYPE
 * from DROP DOMAIN at parse time, so they can't share an AST node.
 */
export class DropDomainBuilder {
  private readonly node: DropDomainNode

  constructor(name: string | string[])
  constructor(node: DropDomainNode)
  constructor(nameOrNode: string | string[] | DropDomainNode) {
    if (typeof nameOrNode === "string") {
      this.node = { type: "drop_domain", names: [nameOrNode] }
    } else if (Array.isArray(nameOrNode)) {
      this.node = { type: "drop_domain", names: [...nameOrNode] }
    } else {
      this.node = nameOrNode
    }
  }

  private clone(patch: Partial<DropDomainNode>): DropDomainBuilder {
    return new DropDomainBuilder({ ...this.node, ...patch })
  }

  ifExists(): DropDomainBuilder {
    return this.clone({ ifExists: true })
  }

  cascade(): DropDomainBuilder {
    return this.clone({ cascade: true })
  }

  restrict(): DropDomainBuilder {
    return this.clone({ restrict: true })
  }

  build(): DropDomainNode {
    return { ...this.node, names: [...this.node.names] }
  }
}

/**
 * Factory for {@link DropDomainBuilder}. Accepts a single name or an
 * array for the multi-drop form.
 */
export function dropDomain(name: string | string[]): DropDomainBuilder {
  return new DropDomainBuilder(name)
}
