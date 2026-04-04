import type { SQLDialect } from "../types.ts"

export function quoteIdentifier(name: string, dialect: SQLDialect): string {
  switch (dialect) {
    case "pg":
    case "sqlite":
      return `"${name.replaceAll('"', '""')}"`
    case "mysql":
      return `\`${name.replaceAll("`", "``")}\``
    case "mssql":
      return `[${name.replaceAll("]", "]]")}]`
  }
}

export function quoteTableRef(name: string, dialect: SQLDialect, schema?: string): string {
  if (schema) {
    return `${quoteIdentifier(schema, dialect)}.${quoteIdentifier(name, dialect)}`
  }
  return quoteIdentifier(name, dialect)
}
