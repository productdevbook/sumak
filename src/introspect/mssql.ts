import type { Driver } from "../driver/types.ts"
import type { IntrospectedColumn, IntrospectedSchema, IntrospectedTable } from "./types.ts"

/**
 * Read a SQL Server schema via the INFORMATION_SCHEMA + sys catalog
 * views. MSSQL's SERIAL analog is IDENTITY; we detect it via
 * `sys.columns.is_identity`.
 */
export async function introspectMssql(
  driver: Driver,
  options: { schema?: string } = {},
): Promise<IntrospectedSchema> {
  const schema = options.schema ?? "dbo"

  const tables = (await driver.query(
    `SELECT TABLE_NAME
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = @p0 AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
    [schema],
  )) as { TABLE_NAME: string }[]

  const columns = (await driver.query(
    `SELECT
       c.TABLE_NAME, c.COLUMN_NAME, c.IS_NULLABLE, c.DATA_TYPE,
       c.COLUMN_DEFAULT,
       sc.is_identity
     FROM INFORMATION_SCHEMA.COLUMNS c
     JOIN sys.columns sc
       ON sc.object_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME)
      AND sc.name = c.COLUMN_NAME
     WHERE c.TABLE_SCHEMA = @p0
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    [schema],
  )) as {
    TABLE_NAME: string
    COLUMN_NAME: string
    IS_NULLABLE: "YES" | "NO"
    DATA_TYPE: string
    COLUMN_DEFAULT: string | null
    is_identity: 0 | 1
  }[]

  const pkRows = (await driver.query(
    `SELECT tc.TABLE_NAME, kcu.COLUMN_NAME
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        AND kcu.TABLE_SCHEMA    = tc.TABLE_SCHEMA
       WHERE tc.TABLE_SCHEMA = @p0 AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`,
    [schema],
  )) as { TABLE_NAME: string; COLUMN_NAME: string }[]
  const pkSet = new Set(pkRows.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`))

  const uqRows = (await driver.query(
    `SELECT tc.TABLE_NAME, kcu.COLUMN_NAME
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        AND kcu.TABLE_SCHEMA    = tc.TABLE_SCHEMA
       WHERE tc.TABLE_SCHEMA = @p0 AND tc.CONSTRAINT_TYPE = 'UNIQUE'`,
    [schema],
  )) as { TABLE_NAME: string; COLUMN_NAME: string }[]
  const uqSet = new Set(uqRows.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`))

  const fkRows = (await driver.query(
    `SELECT
       kcu.TABLE_NAME   AS from_table,
       kcu.COLUMN_NAME  AS from_column,
       OBJECT_NAME(fk.referenced_object_id) AS to_table,
       COL_NAME(fk.referenced_object_id, fkc.referenced_column_id) AS to_column,
       fk.delete_referential_action_desc AS on_delete,
       fk.update_referential_action_desc AS on_update
     FROM sys.foreign_keys fk
     JOIN sys.foreign_key_columns fkc
       ON fkc.constraint_object_id = fk.object_id
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       ON kcu.CONSTRAINT_NAME = fk.name
      AND kcu.TABLE_SCHEMA = @p0
     WHERE SCHEMA_NAME(fk.schema_id) = @p0`,
    [schema],
  )) as {
    from_table: string
    from_column: string
    to_table: string
    to_column: string
    on_delete: string
    on_update: string
  }[]
  const fkMap = new Map<string, (typeof fkRows)[number]>()
  for (const r of fkRows) fkMap.set(`${r.from_table}.${r.from_column}`, r)

  const byTable = new Map<string, IntrospectedColumn[]>()
  for (const row of columns) {
    const pkKey = `${row.TABLE_NAME}.${row.COLUMN_NAME}`
    const fk = fkMap.get(pkKey)
    const col: IntrospectedColumn = {
      name: row.COLUMN_NAME,
      dataType: mapMssqlType(row.DATA_TYPE, row.is_identity === 1),
      nullable: row.IS_NULLABLE === "YES",
      isPrimaryKey: pkSet.has(pkKey),
      isUnique: uqSet.has(pkKey),
      defaultExpression: row.COLUMN_DEFAULT ?? undefined,
      references: fk
        ? {
            table: fk.to_table,
            column: fk.to_column,
            onDelete: fk.on_delete,
            onUpdate: fk.on_update,
          }
        : undefined,
    }
    if (!byTable.has(row.TABLE_NAME)) byTable.set(row.TABLE_NAME, [])
    byTable.get(row.TABLE_NAME)!.push(col)
  }

  const out: IntrospectedTable[] = tables.map((t) => ({
    name: t.TABLE_NAME,
    schema: schema === "dbo" ? undefined : schema,
    columns: byTable.get(t.TABLE_NAME) ?? [],
  }))
  return { dialect: "mssql", tables: out }
}

function mapMssqlType(dataType: string, isIdentity: boolean): string {
  const t = dataType.toLowerCase()
  if (isIdentity && (t === "int" || t === "integer")) return "serial"
  if (isIdentity && t === "bigint") return "bigserial"
  switch (t) {
    case "smallint":
      return "smallint"
    case "int":
      return "integer"
    case "bigint":
      return "bigint"
    case "real":
      return "real"
    case "float":
      return "doublePrecision"
    case "decimal":
    case "numeric":
    case "money":
      return "numeric"
    case "bit":
      return "boolean"
    case "nvarchar":
    case "varchar":
      return "varchar"
    case "nchar":
    case "char":
      return "char"
    case "ntext":
    case "text":
      return "text"
    case "datetime":
    case "datetime2":
    case "smalldatetime":
      return "timestamp"
    case "datetimeoffset":
      return "timestamptz"
    case "date":
      return "date"
    case "time":
      return "time"
    case "uniqueidentifier":
      return "uuid"
    case "varbinary":
    case "binary":
    case "image":
      return "bytea"
    default:
      return t
  }
}
