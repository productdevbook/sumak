export interface ColumnDef {
  readonly dataType: string
  readonly isNotNull: boolean
  readonly hasDefault: boolean
  readonly isPrimaryKey: boolean
  readonly isGenerated: boolean
  readonly references?: { table: string; column: string }
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

  defaultTo(_value: I): ColumnBuilder<S, I | undefined, U> {
    return new ColumnBuilder(this._def.dataType, { ...this._def, hasDefault: true })
  }

  primaryKey(): ColumnBuilder<S, I, U> {
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      isPrimaryKey: true,
      isNotNull: true,
    })
  }

  references(table: string, column: string): ColumnBuilder<S, I, U> {
    return new ColumnBuilder(this._def.dataType, {
      ...this._def,
      references: { table, column },
    })
  }
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

export function bytea(): ColumnBuilder<Buffer, Buffer | Uint8Array, Buffer | Uint8Array> {
  return new ColumnBuilder("bytea")
}

export function enumType<T extends string>(...values: [T, ...T[]]): ColumnBuilder<T, T, T> {
  return new ColumnBuilder(`enum(${values.map((v) => `'${v}'`).join(",")})`)
}
