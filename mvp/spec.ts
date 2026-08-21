import type { Expr } from "./expr.ts"

export interface JoinSpec {
  kind: "INNER" | "LEFT"
  table: string
  alias: string
  on: Expr
}

export interface OrderSpec {
  expr: Expr
  dir: "ASC" | "DESC"
}

export interface Assignment {
  column: string
  expr: Expr
}

export interface Spec {
  op: "select" | "insert" | "update" | "delete"
  table: string
  alias: string
  columns: { expr: Expr; as?: string }[]
  joins: JoinSpec[]
  where?: Expr
  groupBy: Expr[]
  having?: Expr
  orderBy: OrderSpec[]
  limit?: Expr
  offset?: Expr
  distinct: boolean
  rows: Assignment[][]
  returning: string[]
}

export function emptySpec(op: Spec["op"], table: string, alias: string): Spec {
  return {
    op,
    table,
    alias,
    columns: [],
    joins: [],
    groupBy: [],
    orderBy: [],
    distinct: false,
    rows: [],
    returning: [],
  }
}
