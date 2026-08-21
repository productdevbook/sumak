import type { Expr } from "./expr.ts"
import type { Spec } from "./spec.ts"

export interface Dialect {
  quote(identifier: string): string
  placeholder(slot: number): string | null
  positional?: true
}

export const pg: Dialect = {
  quote: (id) => `"${id.replace(/"/g, '""')}"`,
  placeholder: (slot) => `$${slot + 1}`,
}

export const mysql: Dialect = {
  quote: (id) => `\`${id.replace(/`/g, "``")}\``,
  placeholder: () => null,
  positional: true,
}

export const sqlite: Dialect = {
  quote: (id) => `"${id.replace(/"/g, '""')}"`,
  placeholder: (slot) => `?${slot + 1}`,
}

export interface Prepared<A extends readonly unknown[], R> {
  readonly sql: string
  readonly arity: number
  readonly direct: boolean
  bind(args: A): readonly unknown[]
  readonly __row?: R
}

export function compile<A extends readonly unknown[], R>(
  spec: Spec,
  arity: number,
  dialect: Dialect = pg,
): Prepared<A, R> {
  const emitted: number[] = []
  const sql = emit(spec, dialect, emitted)

  const used = new Set(emitted)
  for (const slot of used) {
    if (slot >= arity) {
      throw new Error(`the query uses argument ${slot} but only ${arity} were declared`)
    }
  }
  if (dialect.positional) return positional<A, R>(sql, emitted, arity)

  for (let slot = 0; slot < arity; slot++) {
    if (!used.has(slot)) {
      throw new Error(`parameter ${slot + 1} was declared but never used in the query`)
    }
  }
  return direct<A, R>(sql, arity)
}

function direct<A extends readonly unknown[], R>(sql: string, arity: number): Prepared<A, R> {
  return { sql, arity, direct: true, bind: (args) => args }
}

function positional<A extends readonly unknown[], R>(
  sql: string,
  emitted: number[],
  arity: number,
): Prepared<A, R> {
  const n = emitted.length
  return {
    sql,
    arity,
    direct: false,
    bind(args) {
      const params = Array.from({ length: n })
      for (let i = 0; i < n; i++) params[i] = args[emitted[i]!]
      return params
    },
  }
}

function emit(spec: Spec, d: Dialect, emitted: number[]): string {
  switch (spec.op) {
    case "select":
      return emitSelect(spec, d, emitted)
    case "insert":
      return emitInsert(spec, d, emitted)
    case "update":
      return emitUpdate(spec, d, emitted)
    case "delete":
      return emitDelete(spec, d, emitted)
  }
}

function source(spec: Spec, d: Dialect): string {
  return spec.alias === spec.table
    ? d.quote(spec.table)
    : `${d.quote(spec.table)} AS ${d.quote(spec.alias)}`
}

function emitSelect(spec: Spec, d: Dialect, e: number[]): string {
  const parts = ["SELECT"]
  if (spec.distinct) parts.push("DISTINCT")

  parts.push(
    spec.columns.length === 0
      ? "*"
      : spec.columns
          .map((c) => (c.as ? `${expr(c.expr, d, e)} AS ${d.quote(c.as)}` : expr(c.expr, d, e)))
          .join(", "),
  )

  parts.push("FROM", source(spec, d))

  for (const j of spec.joins) {
    const target =
      j.alias === j.table ? d.quote(j.table) : `${d.quote(j.table)} AS ${d.quote(j.alias)}`
    parts.push(`${j.kind} JOIN`, target, "ON", expr(j.on, d, e))
  }

  if (spec.where) parts.push("WHERE", expr(spec.where, d, e))
  if (spec.groupBy.length > 0) {
    parts.push("GROUP BY", spec.groupBy.map((g) => expr(g, d, e)).join(", "))
  }
  if (spec.having) parts.push("HAVING", expr(spec.having, d, e))
  if (spec.orderBy.length > 0) {
    parts.push("ORDER BY", spec.orderBy.map((o) => `${expr(o.expr, d, e)} ${o.dir}`).join(", "))
  }
  if (spec.limit) parts.push("LIMIT", expr(spec.limit, d, e))
  if (spec.offset) parts.push("OFFSET", expr(spec.offset, d, e))

  return parts.join(" ")
}

function emitInsert(spec: Spec, d: Dialect, e: number[]): string {
  const first = spec.rows[0]
  if (first === undefined) throw new Error("insert needs at least one row")
  const columns = first.map((s) => d.quote(s.column)).join(", ")
  const rows = spec.rows
    .map((row) => `(${row.map((s) => expr(s.expr, d, e)).join(", ")})`)
    .join(", ")
  const parts = [`INSERT INTO ${d.quote(spec.table)} (${columns}) VALUES ${rows}`]
  if (spec.returning.length > 0) {
    parts.push("RETURNING", spec.returning.map((c) => d.quote(c)).join(", "))
  }
  return parts.join(" ")
}

function emitUpdate(spec: Spec, d: Dialect, e: number[]): string {
  const row = spec.rows[0]
  if (row === undefined) throw new Error("update needs at least one assignment")
  const parts = [
    "UPDATE",
    d.quote(spec.table),
    "SET",
    row.map((s) => `${d.quote(s.column)} = ${expr(s.expr, d, e)}`).join(", "),
  ]
  if (spec.where) parts.push("WHERE", expr(spec.where, d, e))
  if (spec.returning.length > 0) {
    parts.push("RETURNING", spec.returning.map((c) => d.quote(c)).join(", "))
  }
  return parts.join(" ")
}

function emitDelete(spec: Spec, d: Dialect, e: number[]): string {
  const parts = ["DELETE FROM", d.quote(spec.table)]
  if (spec.where) parts.push("WHERE", expr(spec.where, d, e))
  if (spec.returning.length > 0) {
    parts.push("RETURNING", spec.returning.map((c) => d.quote(c)).join(", "))
  }
  return parts.join(" ")
}

function expr(node: Expr, d: Dialect, e: number[]): string {
  switch (node.k) {
    case "col":
      return `${d.quote(node.t)}.${d.quote(node.c)}`
    case "lit":
      return literal(node.v)
    case "param": {
      e.push(node.slot)
      return d.placeholder(node.slot) ?? "?"
    }
    case "bin":
      return `(${expr(node.l, d, e)} ${node.op} ${expr(node.r, d, e)})`
    case "in":
      return `${expr(node.e, d, e)} ${node.not ? "NOT IN" : "IN"} (${node.vs
        .map((v) => expr(v, d, e))
        .join(", ")})`
    case "null":
      return `${expr(node.e, d, e)} IS ${node.not ? "NOT NULL" : "NULL"}`
  }
}

function literal(v: string | number | boolean | null): string {
  if (v === null) return "NULL"
  switch (typeof v) {
    case "number":
      if (!Number.isFinite(v)) throw new Error(`cannot emit ${v} as a literal`)
      return String(v)
    case "boolean":
      return v ? "TRUE" : "FALSE"
    default:
      return `'${v.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`
  }
}
