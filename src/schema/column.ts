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

/**
 * Generated column descriptor. When set, the column is emitted as
 * `GENERATED ALWAYS AS (<expression>) [STORED]`. `stored: true` is
 * PG-12+ (persisted to disk); omitting it yields VIRTUAL on MySQL /
 * MSSQL and is a syntax error on SQLite (all SQLite generated
 * columns have to be marked one or the other — the DDL printer
 * already throws a helpful error in that case).
 */
export interface GeneratedDef {
  readonly expression: ExpressionNode
  readonly stored?: boolean
}

export interface ColumnDef {
  readonly dataType: string
  readonly isNotNull: boolean
  readonly hasDefault: boolean
  /** Literal default value. Set when the caller wrote `.defaultTo(123)`. */
  readonly defaultValue?: unknown
  /**
   * Expression default AST. Set when the caller wrote
   * `.defaultTo(sql\`CURRENT_TIMESTAMP\`)` or `.defaultTo(sql\`gen_random_uuid()\`)`.
   * The migration diff engine prefers this over `defaultValue` when
   * emitting a `DEFAULT` clause on `CREATE TABLE`.
   */
  readonly defaultExpression?: ExpressionNode
  readonly isPrimaryKey: boolean
  readonly isUnique: boolean
  readonly isGenerated: boolean
  /**
   * `GENERATED ALWAYS AS (<expr>) [STORED]` descriptor. When set, the
   * column's value is computed from the expression and cannot be
   * written via INSERT / UPDATE — enforced at the DB; sumak's typed
   * builders treat it as a read-only column at the type layer when
   * the schema DSL is used.
   */
  readonly generated?: GeneratedDef
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

  /**
   * Attach a default value or default-generating expression.
   *
   * Two call shapes:
   *
   * ```ts
   * boolean().defaultTo(true)                        // literal
   * timestamp().defaultTo(sql`CURRENT_TIMESTAMP`)    // expression
   * uuid().defaultTo(sql`gen_random_uuid()`)         // PG expression
   * ```
   *
   * When a sumak `Expression` is passed, the AST node is preserved
   * on `ColumnDef.defaultExpression` and the DDL printer emits the
   * expression verbatim in the `DEFAULT` clause (with dialect-aware
   * quoting for any column refs). Literal values take the legacy
   * path via `ColumnDef.defaultValue`. Expression defaults mark the
   * column as optional on insert — the DB fills the value, the
   * INSERT row can omit the column.
   */
  defaultTo(value: I | Expression<I>): ColumnBuilder<S, I | undefined, U> {
    const isExpr =
      value !== null &&
      typeof value === "object" &&
      "node" in (value as unknown as { node?: unknown })
    if (isExpr) {
      const node = (value as unknown as { node: ExpressionNode }).node
      return new ColumnBuilder(this._def.dataType, {
        ...this._def,
        hasDefault: true,
        defaultExpression: node,
      })
    }
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      hasDefault: true,
      defaultValue: value as unknown,
    })
  }

  /**
   * Mark the column as `GENERATED ALWAYS AS (<expression>) [STORED]`.
   * The expression is a sumak `Expression` that references other
   * columns via `sql\`...\``. `stored: true` persists the computed
   * value (PG 12+, MySQL, MSSQL); omitting it yields a virtual
   * computed column on MySQL / MSSQL. SQLite rejects generated
   * columns without an explicit mode — the DDL printer surfaces the
   * engine's error rather than guessing.
   *
   * Generated columns are read-only at the DB level. The typed
   * builder layer treats them as optional on insert / update — the
   * DB rejects writes either way, so the type system just follows
   * suit.
   */
  generatedAlwaysAs(
    expression: Expression<S>,
    options?: { stored?: boolean },
  ): ColumnBuilder<S, I | undefined, U | undefined> {
    const node = (expression as unknown as { node: ExpressionNode }).node
    const generated: GeneratedDef =
      options?.stored === undefined
        ? { expression: node }
        : { expression: node, stored: options.stored }
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      isGenerated: true,
      generated,
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
