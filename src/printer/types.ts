import type { CompiledQuery, SQLDialect } from "../types.ts"

export type PrintMode = "compact" | "formatted" | "debug"

export interface PrinterOptions {
  dialect: SQLDialect
  mode?: PrintMode
  indent?: string
  width?: number
}

export interface Printer {
  print(node: import("../ast/nodes.ts").ASTNode): CompiledQuery
  /**
   * Convert one value into the form the driver accepts.
   *
   * Printing does this on the way past. It is exposed because a compiled query
   * fills its placeholders without printing anything, and both paths have to
   * hand the driver the same values — a `bigint` reaching `pg` unconverted is
   * rejected by the driver.
   */
  coerceParam(value: unknown): unknown
}
