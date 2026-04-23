import type { Driver } from "../driver/types.ts"
import type { IntrospectedColumn, IntrospectedSchema, IntrospectedTable } from "./types.ts"

/**
 * Read a MySQL database's schema from the driver, normalised to the
 * shared {@link IntrospectedSchema} shape.
 *
 * Queries `information_schema.tables`, `columns`, `key_column_usage`,
 * `referential_constraints`. MySQL reports PRIMARY/UNIQUE on the
 * column rows too (via COLUMN_KEY = 'PRI' / 'UNI'), so key detection
 * is slightly cheaper than on PG.
 *
 * `database` defaults to the current `DATABASE()` — i.e. whichever
 * schema the driver is currently pointed at.
 */
export async function introspectMysql(
  driver: Driver,
  options: { database?: string } = {},
): Promise<IntrospectedSchema> {
  const database = options.database

  const dbClause = database ? `AND table_schema = ?` : `AND table_schema = DATABASE()`
  const params = database ? [database] : []

  const tables = (await driver.query(
    `SELECT table_name
       FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' ${dbClause}
       ORDER BY table_name`,
    params,
  )) as { table_name: string }[]

  const columns = (await driver.query(
    `SELECT
       table_name, column_name, is_nullable, data_type, column_type,
       column_default, column_key, extra
     FROM information_schema.columns
     WHERE 1=1 ${dbClause}
     ORDER BY table_name, ordinal_position`,
    params,
  )) as {
    table_name: string
    column_name: string
    is_nullable: "YES" | "NO"
    data_type: string
    column_type: string
    column_default: string | null
    column_key: "" | "PRI" | "UNI" | "MUL"
    extra: string
  }[]

  const fks = (await driver.query(
    `SELECT
       kcu.table_name            AS from_table,
       kcu.column_name           AS from_column,
       kcu.referenced_table_name AS to_table,
       kcu.referenced_column_name AS to_column,
       rc.delete_rule            AS on_delete,
       rc.update_rule            AS on_update
     FROM information_schema.key_column_usage kcu
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name   = kcu.constraint_name
      AND rc.constraint_schema = kcu.constraint_schema
     WHERE kcu.referenced_table_name IS NOT NULL ${dbClause.replace(/table_schema/g, "kcu.table_schema")}`,
    params,
  )) as {
    from_table: string
    from_column: string
    to_table: string
    to_column: string
    on_delete: string
    on_update: string
  }[]
  const fkMap = new Map<string, (typeof fks)[number]>()
  for (const r of fks) fkMap.set(`${r.from_table}.${r.from_column}`, r)

  const byTable = new Map<string, IntrospectedColumn[]>()
  for (const row of columns) {
    const isSerial = row.extra.includes("auto_increment")
    const pkKey = `${row.table_name}.${row.column_name}`
    const fk = fkMap.get(pkKey)
    const col: IntrospectedColumn = {
      name: row.column_name,
      dataType: mapMysqlType(row.data_type, isSerial),
      nullable: row.is_nullable === "YES",
      isPrimaryKey: row.column_key === "PRI",
      isUnique: row.column_key === "UNI",
      defaultExpression: row.column_default ?? undefined,
      references: fk
        ? {
            table: fk.to_table,
            column: fk.to_column,
            onDelete: fk.on_delete,
            onUpdate: fk.on_update,
          }
        : undefined,
    }
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, [])
    byTable.get(row.table_name)!.push(col)
  }

  const out: IntrospectedTable[] = tables.map((t) => ({
    name: t.table_name,
    columns: byTable.get(t.table_name) ?? [],
  }))
  return { dialect: "mysql", tables: out }
}

function mapMysqlType(dataType: string, isSerial: boolean): string {
  const t = dataType.toLowerCase()
  if (isSerial) {
    if (t === "int" || t === "integer") return "serial"
    if (t === "bigint") return "bigserial"
  }
  switch (t) {
    case "smallint":
      return "smallint"
    case "int":
    case "integer":
      return "integer"
    case "bigint":
      return "bigint"
    case "float":
      return "real"
    case "double":
      return "doublePrecision"
    case "decimal":
    case "numeric":
      return "numeric"
    case "tinyint":
      // MySQL convention: tinyint(1) ≈ boolean. Without the (1) info here
      // we'd conflate real tiny ints; err toward integer and let users
      // switch to boolean() manually if needed.
      return "integer"
    case "varchar":
      return "varchar"
    case "char":
      return "char"
    case "text":
    case "longtext":
    case "mediumtext":
    case "tinytext":
      return "text"
    case "datetime":
    case "timestamp":
      return "timestamp"
    case "date":
      return "date"
    case "time":
      return "time"
    case "json":
      return "json"
    case "blob":
    case "longblob":
    case "mediumblob":
    case "tinyblob":
    case "binary":
    case "varbinary":
      return "bytea"
    default:
      return t
  }
}
