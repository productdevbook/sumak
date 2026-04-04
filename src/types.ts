export type SQLDialect = "pg" | "mysql" | "sqlite" | "mssql"

export interface CompiledQuery {
  sql: string
  params: readonly unknown[]
}

export type Primitive = string | number | boolean | null

export type OrderDirection = "ASC" | "DESC"

export type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS"

export type SetOperator =
  | "UNION"
  | "UNION ALL"
  | "INTERSECT"
  | "INTERSECT ALL"
  | "EXCEPT"
  | "EXCEPT ALL"

export interface DialectConfig {
  name: SQLDialect
  quoteIdentifier(name: string): string
  formatParam(index: number): string
}
