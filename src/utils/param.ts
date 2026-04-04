import type { SQLDialect } from "../types.ts"

export function formatParam(index: number, dialect: SQLDialect): string {
  switch (dialect) {
    case "pg":
      return `$${index + 1}`
    case "mysql":
    case "sqlite":
      return "?"
  }
}
