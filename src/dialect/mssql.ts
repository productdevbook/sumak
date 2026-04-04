import { MssqlPrinter } from "../printer/mssql.ts"
import type { Dialect } from "./types.ts"

export function mssqlDialect(): Dialect {
  return {
    name: "mssql",
    createPrinter() {
      return new MssqlPrinter()
    },
  }
}
