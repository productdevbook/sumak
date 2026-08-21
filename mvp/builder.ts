import type { Dialect, Prepared } from "./compile.ts"
import { compile, pg } from "./compile.ts"
import type { Args, Kind, Operand, Param, Slots } from "./expr.ts"
import { columnMap, param, Ref } from "./expr.ts"
import type { Column, Schema } from "./schema.ts"
import type { Assignment, JoinSpec, Spec } from "./spec.ts"
import { emptySpec } from "./spec.ts"

export type Row<S extends Schema, N extends keyof S> = {
  [C in keyof S[N]]: S[N][C] extends Column<infer V> ? V : never
}

type Scope<S extends Schema, N extends keyof S> = {
  [T in N]: { [C in keyof S[T]]: Ref<S[T][C] extends Column<infer V> ? V : never> }
}

type Writable<S extends Schema, N extends keyof S> = {
  [C in keyof S[N]]?: Operand<S[N][C] extends Column<infer V> ? V : never>
}

export class Db<S extends Schema> {
  readonly names: Record<string, string[]> = {}
  readonly scopes: Record<string, Record<string, Ref<never>>> = {}

  constructor(
    readonly schema: S,
    readonly dialect: Dialect = pg,
  ) {
    for (const table in schema) {
      this.names[table] = Object.keys(schema[table] as Record<string, Column<unknown>>)
      this.scopes[table] = columnMap(table, this.names[table]!)
    }
  }

  refs(table: string, alias: string): Record<string, Ref<never>> {
    return alias === table ? this.scopes[table]! : columnMap(alias, this.names[table]!)
  }

  from<N extends keyof S & string>(table: N, as?: string): Select<S, N, []> {
    return new Select(this, table, as ?? table, [])
  }

  insertInto<N extends keyof S & string>(table: N): Insert<S, N, []> {
    return new Insert(this, table, [])
  }

  update<N extends keyof S & string>(table: N): Update<S, N, []> {
    return new Update(this, table, [])
  }

  deleteFrom<N extends keyof S & string>(table: N): Delete<S, N, []> {
    return new Delete(this, table, [])
  }
}

abstract class Query<S extends Schema, N extends keyof S & string, A extends readonly unknown[]> {
  protected readonly spec: Spec
  protected readonly scope: Record<string, Record<string, Ref<never>>>
  protected slots: Param<never>[] = []

  constructor(
    protected readonly db: Db<S>,
    op: Spec["op"],
    table: N,
    alias: string,
    protected declared: readonly Kind<unknown>[],
  ) {
    this.spec = emptySpec(op, table, alias)
    this.scope = { [alias]: db.refs(table, alias) }
    this.slots = declared.map((_, i) => param(i))
  }

  protected get p(): Slots<A> {
    return this.slots as unknown as Slots<A>
  }

  protected get cols(): Scope<S, N> {
    return this.scope as unknown as Scope<S, N>
  }

  protected assignments<T extends Record<string, unknown>>(row: T): Assignment[] {
    const out: Assignment[] = []
    for (const column in row) {
      const value = row[column] as Operand<unknown> | undefined
      if (value === undefined) continue
      out.push({ column, expr: value.expr })
    }
    return out
  }
}

export class Select<
  S extends Schema,
  N extends keyof S & string,
  A extends readonly unknown[],
  R = Row<S, N>,
> extends Query<S, N, A> {
  constructor(db: Db<S>, table: N, alias: string, declared: readonly Kind<unknown>[]) {
    super(db, "select", table, alias, declared)
  }

  params<K extends readonly Kind<unknown>[]>(...kinds: K): Select<S, N, Args<K>, R> {
    this.declared = kinds
    this.slots = kinds.map((_, i) => param(i))
    return this as unknown as Select<S, N, Args<K>, R>
  }

  pick<C extends keyof S[N] & string>(...columns: C[]): Select<S, N, A, Pick<Row<S, N>, C>> {
    for (const c of columns) {
      this.spec.columns.push({ expr: { k: "col", t: this.spec.alias, c } })
    }
    return this as unknown as Select<S, N, A, Pick<Row<S, N>, C>>
  }

  distinct(): this {
    this.spec.distinct = true
    return this
  }

  join<T extends keyof S & string>(
    table: T,
    on: (c: Scope<S, N | T>, p: Slots<A>) => Ref<boolean>,
    options: { as?: string; kind?: JoinSpec["kind"] } = {},
  ): Select<S, N | T, A, R> {
    const alias = options.as ?? table
    this.scope[alias] = this.db.refs(table, alias)
    const wider = this.scope as unknown as Scope<S, N | T>
    this.spec.joins.push({
      kind: options.kind ?? "INNER",
      table,
      alias,
      on: on(wider, this.p).expr,
    })
    return this as unknown as Select<S, N | T, A, R>
  }

  leftJoin<T extends keyof S & string>(
    table: T,
    on: (c: Scope<S, N | T>, p: Slots<A>) => Ref<boolean>,
    options: { as?: string } = {},
  ): Select<S, N | T, A, R> {
    return this.join(table, on, { ...options, kind: "LEFT" })
  }

  where(predicate: (c: Scope<S, N>, p: Slots<A>) => Ref<boolean>): this {
    const next = predicate(this.cols, this.p).expr
    this.spec.where = this.spec.where ? { k: "bin", op: "AND", l: this.spec.where, r: next } : next
    return this
  }

  groupBy(...columns: (keyof S[N] & string)[]): this {
    for (const c of columns) this.spec.groupBy.push({ k: "col", t: this.spec.alias, c })
    return this
  }

  having(predicate: (c: Scope<S, N>, p: Slots<A>) => Ref<boolean>): this {
    this.spec.having = predicate(this.cols, this.p).expr
    return this
  }

  orderBy(column: keyof S[N] & string, dir: "ASC" | "DESC" = "ASC"): this {
    this.spec.orderBy.push({ expr: { k: "col", t: this.spec.alias, c: column }, dir })
    return this
  }

  limit(n: number | ((p: Slots<A>) => Param<number>)): this {
    this.spec.limit = typeof n === "number" ? { k: "lit", v: n } : n(this.p).expr
    return this
  }

  offset(n: number | ((p: Slots<A>) => Param<number>)): this {
    this.spec.offset = typeof n === "number" ? { k: "lit", v: n } : n(this.p).expr
    return this
  }

  build(): Prepared<A, R> {
    return compile(this.spec, this.declared.length, this.db.dialect)
  }
}

export class Insert<
  S extends Schema,
  N extends keyof S & string,
  A extends readonly unknown[],
  R = never,
> extends Query<S, N, A> {
  constructor(db: Db<S>, table: N, declared: readonly Kind<unknown>[]) {
    super(db, "insert", table, table, declared)
  }

  params<K extends readonly Kind<unknown>[]>(...kinds: K): Insert<S, N, Args<K>, R> {
    this.declared = kinds
    this.slots = kinds.map((_, i) => param(i))
    return this as unknown as Insert<S, N, Args<K>, R>
  }

  values(build: (p: Slots<A>) => Writable<S, N>[]): this {
    for (const row of build(this.p)) {
      this.spec.rows.push(this.assignments(row as Record<string, unknown>))
    }
    return this
  }

  returning<C extends keyof S[N] & string>(...columns: C[]): Insert<S, N, A, Pick<Row<S, N>, C>> {
    this.spec.returning.push(...columns)
    return this as unknown as Insert<S, N, A, Pick<Row<S, N>, C>>
  }

  build(): Prepared<A, R> {
    return compile(this.spec, this.declared.length, this.db.dialect)
  }
}

export class Update<
  S extends Schema,
  N extends keyof S & string,
  A extends readonly unknown[],
  R = never,
> extends Query<S, N, A> {
  constructor(db: Db<S>, table: N, declared: readonly Kind<unknown>[]) {
    super(db, "update", table, table, declared)
  }

  params<K extends readonly Kind<unknown>[]>(...kinds: K): Update<S, N, Args<K>, R> {
    this.declared = kinds
    this.slots = kinds.map((_, i) => param(i))
    return this as unknown as Update<S, N, Args<K>, R>
  }

  set(build: (p: Slots<A>) => Writable<S, N>): this {
    this.spec.rows.push(this.assignments(build(this.p) as Record<string, unknown>))
    return this
  }

  where(predicate: (c: Scope<S, N>, p: Slots<A>) => Ref<boolean>): this {
    const next = predicate(this.cols, this.p).expr
    this.spec.where = this.spec.where ? { k: "bin", op: "AND", l: this.spec.where, r: next } : next
    return this
  }

  returning<C extends keyof S[N] & string>(...columns: C[]): Update<S, N, A, Pick<Row<S, N>, C>> {
    this.spec.returning.push(...columns)
    return this as unknown as Update<S, N, A, Pick<Row<S, N>, C>>
  }

  build(): Prepared<A, R> {
    return compile(this.spec, this.declared.length, this.db.dialect)
  }
}

export class Delete<
  S extends Schema,
  N extends keyof S & string,
  A extends readonly unknown[],
  R = never,
> extends Query<S, N, A> {
  constructor(db: Db<S>, table: N, declared: readonly Kind<unknown>[]) {
    super(db, "delete", table, table, declared)
  }

  params<K extends readonly Kind<unknown>[]>(...kinds: K): Delete<S, N, Args<K>, R> {
    this.declared = kinds
    this.slots = kinds.map((_, i) => param(i))
    return this as unknown as Delete<S, N, Args<K>, R>
  }

  where(predicate: (c: Scope<S, N>, p: Slots<A>) => Ref<boolean>): this {
    const next = predicate(this.cols, this.p).expr
    this.spec.where = this.spec.where ? { k: "bin", op: "AND", l: this.spec.where, r: next } : next
    return this
  }

  returning<C extends keyof S[N] & string>(...columns: C[]): Delete<S, N, A, Pick<Row<S, N>, C>> {
    this.spec.returning.push(...columns)
    return this as unknown as Delete<S, N, A, Pick<Row<S, N>, C>>
  }

  build(): Prepared<A, R> {
    return compile(this.spec, this.declared.length, this.db.dialect)
  }
}

export function db<S extends Schema>(schema: S, dialect: Dialect = pg): Db<S> {
  return new Db(schema, dialect)
}
