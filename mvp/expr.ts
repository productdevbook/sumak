export type Expr =
  | { k: "col"; t: string; c: string }
  | { k: "lit"; v: string | number | boolean | null }
  | { k: "param"; slot: number }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "in"; e: Expr; vs: Expr[]; not: boolean }
  | { k: "null"; e: Expr; not: boolean }

declare const brand: unique symbol

export interface Param<T> {
  readonly expr: Expr
  readonly [brand]: ["param", T]
}

export interface Lit<T> {
  readonly expr: Expr
  readonly [brand]: ["lit", T]
}

export type Operand<T> = Param<T> | Lit<T> | Ref<T>

export function lit<T extends string | number | boolean | null>(value: T): Lit<T> {
  return { expr: { k: "lit", v: value } } as Lit<T>
}

export function param(slot: number): Param<never> {
  return { expr: { k: "param", slot } } as Param<never>
}

export class Ref<T> {
  constructor(readonly expr: Expr) {}

  private bin(op: string, value: Operand<T>): Ref<boolean> {
    return new Ref<boolean>({ k: "bin", op, l: this.expr, r: value.expr })
  }

  eq(value: Operand<T>): Ref<boolean> {
    return this.bin("=", value)
  }
  neq(value: Operand<T>): Ref<boolean> {
    return this.bin("<>", value)
  }
  gt(value: Operand<T>): Ref<boolean> {
    return this.bin(">", value)
  }
  gte(value: Operand<T>): Ref<boolean> {
    return this.bin(">=", value)
  }
  lt(value: Operand<T>): Ref<boolean> {
    return this.bin("<", value)
  }
  lte(value: Operand<T>): Ref<boolean> {
    return this.bin("<=", value)
  }
  like(value: Operand<T & string>): Ref<boolean> {
    return new Ref<boolean>({ k: "bin", op: "LIKE", l: this.expr, r: value.expr })
  }
  in(values: Operand<T>[]): Ref<boolean> {
    return new Ref<boolean>({
      k: "in",
      e: this.expr,
      vs: values.map((v) => v.expr),
      not: false,
    })
  }
  notIn(values: Operand<T>[]): Ref<boolean> {
    return new Ref<boolean>({ k: "in", e: this.expr, vs: values.map((v) => v.expr), not: true })
  }
  isNull(): Ref<boolean> {
    return new Ref<boolean>({ k: "null", e: this.expr, not: false })
  }
  isNotNull(): Ref<boolean> {
    return new Ref<boolean>({ k: "null", e: this.expr, not: true })
  }
}

export function and(...parts: Ref<boolean>[]): Ref<boolean> {
  return fold("AND", parts)
}

export function or(...parts: Ref<boolean>[]): Ref<boolean> {
  return fold("OR", parts)
}

export function not(part: Ref<boolean>): Ref<boolean> {
  return new Ref<boolean>({ k: "bin", op: "AND", l: { k: "lit", v: true }, r: negate(part.expr) })
}

function negate(e: Expr): Expr {
  if (e.k === "null") return { ...e, not: !e.not }
  if (e.k === "in") return { ...e, not: !e.not }
  return { k: "bin", op: "=", l: { k: "lit", v: false }, r: e }
}

function fold(op: string, parts: Ref<boolean>[]): Ref<boolean> {
  const first = parts[0]
  if (first === undefined) throw new Error(`${op}() needs at least one predicate`)
  let expr = first.expr
  for (let i = 1; i < parts.length; i++) {
    expr = { k: "bin", op, l: expr, r: parts[i]!.expr }
  }
  return new Ref<boolean>(expr)
}

export interface Kind<T> {
  readonly [brand]?: ["kind", T]
}

export const t = {
  num: {} as Kind<number>,
  text: {} as Kind<string>,
  bool: {} as Kind<boolean>,
  date: {} as Kind<Date>,
  json: {} as Kind<unknown>,
}

export type Args<K extends readonly Kind<unknown>[]> = {
  [I in keyof K]: K[I] extends Kind<infer T> ? T : never
}

export type Slots<A extends readonly unknown[]> = {
  [I in keyof A]: Param<A[I]>
}

export function columnMap(qualifier: string, names: readonly string[]): Record<string, Ref<never>> {
  const out: Record<string, Ref<never>> = {}
  for (const name of names) {
    out[name] = new Ref<never>({ k: "col", t: qualifier, c: name })
  }
  return Object.freeze(out)
}
