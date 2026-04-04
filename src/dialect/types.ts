import type { Printer } from "../printer/types.ts"
import type { SQLDialect } from "../types.ts"

export interface Dialect {
  name: SQLDialect
  createPrinter(): Printer
}
