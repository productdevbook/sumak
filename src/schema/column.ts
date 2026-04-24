import type { ForeignKeyAction } from "../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../ast/nodes.ts"
import type { Expression } from "../ast/typed-expression.ts"
import { escapeStringLiteral } from "../utils/security.ts"

/**
 * Column-level CHECK constraint metadata. Captured on the builder and
 * lowered to a {@link ColumnDefinitionNode.check} by the migration diff
 * engine (or directly by DDL emitters that walk {@link ColumnDef}).
 *
 * The expression may be:
 * - a raw SQL fragment (will flow through `unsafeRawExpr` — caller is
 *   responsible for the content; CHECK expressions are defined at
 *   schema-design time, not accepted from user input);
 * - a sumak {@link Expression} produced via `sql\`...\`` or builder
 *   helpers, in which case the pre-built AST node is reused verbatim.
 */
export interface ColumnCheckDef {
  readonly name?: string
  readonly sql: string
  readonly params?: readonly unknown[]
  readonly node?: ExpressionNode
}

export interface ColumnDef {
  readonly dataType: string
  readonly isNotNull: boolean
  readonly hasDefault: boolean
  readonly defaultValue?: unknown
  readonly isPrimaryKey: boolean
  readonly isUnique: boolean
  readonly isGenerated: boolean
  readonly check?: ColumnCheckDef
  readonly references?: {
    table: string
    column: string
    onDelete?: ForeignKeyAction
    onUpdate?: ForeignKeyAction
  }
}

export class ColumnBuilder<S, I = S, U = I> {
  /** @internal */
  readonly _def: ColumnDef

  /**
   * Phantom branded fields — carry type info for indexed access.
   * tsgo resolves `C["__select"]` via O(1) symbol table lookup,
   * avoiding conditional type evaluation entirely.
   */
  declare readonly __select: S
  declare readonly __insert: I
  declare readonly __update: U

  constructor(dataType: string, def?: Partial<ColumnDef>) {
    this._def = {
      dataType,
      isNotNull: false,
      hasDefault: false,
      isPrimaryKey: false,
      isUnique: false,
      isGenerated: false,
      ...def,
    }
  }

  notNull(): ColumnBuilder<Exclude<S, null>, Exclude<I, null>, Exclude<U, null>> {
    return new ColumnBuilder(this._def.dataType, { ...this._def, isNotNull: true })
  }

  nullable(): ColumnBuilder<S | null, I | null | undefined, U | null | undefined> {
    return new ColumnBuilder(this._def.dataType, { ...this._def, isNotNull: false })
  }

  defaultTo(value: I): ColumnBuilder<S, I | undefined, U> {
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      hasDefault: true,
      defaultValue: value,
    })
  }

  primaryKey(): ColumnBuilder<S, I, U> {
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      isPrimaryKey: true,
      isNotNull: true,
    })
  }

  unique(): ColumnBuilder<S, I, U> {
    return new ColumnBuilder(this._def.dataType, { ...this._def, isUnique: true })
  }

  references(table: string, column: string): ColumnBuilder<S, I, U> {
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      references: { table, column },
    })
  }

  onDelete(action: ForeignKeyAction): ColumnBuilder<S, I, U> {
    if (!this._def.references) return this as any
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      references: { ...this._def.references, onDelete: action },
    })
  }

  onUpdate(action: ForeignKeyAction): ColumnBuilder<S, I, U> {
    if (!this._def.references) return this as any
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      references: { ...this._def.references, onUpdate: action },
    })
  }

  /**
   * Attach a CHECK constraint to this column.
   *
   * Two shapes:
   *
   * ```ts
   * integer().check(sql`age >= 0`)                  // Expression form
   * integer().check("age >= 0", { name: "ck_age" }) // raw SQL + opt name
   * ```
   *
   * The constraint is emitted inline in `CREATE TABLE` and materialized
   * as an `ADD CONSTRAINT ... CHECK (...)` when diffed into an existing
   * schema. Expression-form values are preserved as AST nodes so they
   * retain parameters through the printer pipeline.
   */
  check(expr: Expression<boolean> | string, opts?: { name?: string }): ColumnBuilder<S, I, U> {
    const check = normalizeCheck(expr, opts?.name)
    return new ColumnBuilder(this._def.dataType, { ...this._def, check })
  }
}

function normalizeCheck(
  expr: Expression<boolean> | string,
  name: string | undefined,
): ColumnCheckDef {
  if (typeof expr === "string") {
    return name === undefined ? { sql: expr } : { name, sql: expr }
  }
  // Expression<boolean> — pull the AST node out so the printer resolves
  // it with proper dialect quoting and parameter binding at print time.
  const node = (expr as unknown as { node: ExpressionNode }).node
  // We still keep a best-effort raw `sql` around for introspection-style
  // round-tripping: empty string signals "use node only". The DDL emitter
  // will prefer the node when present.
  return name === undefined ? { sql: "", node } : { name, sql: "", node }
}

// Column factory functions

export function integer(): ColumnBuilder<number, number, number> {
  return new ColumnBuilder("integer")
}

export function bigint(): ColumnBuilder<bigint, bigint | number, bigint | number> {
  return new ColumnBuilder("bigint")
}

export function smallint(): ColumnBuilder<number, number, number> {
  return new ColumnBuilder("smallint")
}

export function serial(): ColumnBuilder<number, number | undefined, number> {
  return new ColumnBuilder("serial", { hasDefault: true, isNotNull: true, isPrimaryKey: true })
}

export function bigserial(): ColumnBuilder<bigint, bigint | undefined, bigint> {
  return new ColumnBuilder("bigserial", { hasDefault: true, isNotNull: true })
}

export function text(): ColumnBuilder<string, string, string> {
  return new ColumnBuilder("text")
}

export function varchar(length?: number): ColumnBuilder<string, string, string> {
  return new ColumnBuilder(length ? `varchar(${length})` : "varchar")
}

export function char(length?: number): ColumnBuilder<string, string, string> {
  return new ColumnBuilder(length ? `char(${length})` : "char")
}

export function boolean(): ColumnBuilder<boolean, boolean, boolean> {
  return new ColumnBuilder("boolean")
}

export function timestamp(): ColumnBuilder<Date, Date | string, Date | string> {
  return new ColumnBuilder("timestamp")
}

export function timestamptz(): ColumnBuilder<Date, Date | string, Date | string> {
  return new ColumnBuilder("timestamptz")
}

export function date(): ColumnBuilder<Date, Date | string, Date | string> {
  return new ColumnBuilder("date")
}

export function time(): ColumnBuilder<string, string, string> {
  return new ColumnBuilder("time")
}

export function uuid(): ColumnBuilder<string, string, string> {
  return new ColumnBuilder("uuid")
}

export function json<T = unknown>(): ColumnBuilder<T, T, T> {
  return new ColumnBuilder("json")
}

export function jsonb<T = unknown>(): ColumnBuilder<T, T, T> {
  return new ColumnBuilder("jsonb")
}

export function numeric(
  precision?: number,
  scale?: number,
): ColumnBuilder<string, string | number, string | number> {
  const dt =
    precision != null
      ? scale != null
        ? `numeric(${precision},${scale})`
        : `numeric(${precision})`
      : "numeric"
  return new ColumnBuilder(dt)
}

export function real(): ColumnBuilder<number, number, number> {
  return new ColumnBuilder("real")
}

export function doublePrecision(): ColumnBuilder<number, number, number> {
  return new ColumnBuilder("double precision")
}

export function bytea(): ColumnBuilder<Uint8Array, Uint8Array, Uint8Array> {
  return new ColumnBuilder("bytea")
}

export function enumType<T extends string>(...values: [T, ...T[]]): ColumnBuilder<T, T, T> {
  const escaped = values.map((v) => `'${escapeStringLiteral(v)}'`).join(",")
  return new ColumnBuilder(`enum(${escaped})`)
}

export function interval(): ColumnBuilder<string, string, string> {
  return new ColumnBuilder("interval")
}
