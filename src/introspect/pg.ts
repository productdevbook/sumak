import type { Driver } from "../driver/types.ts"
import type { IntrospectedColumn, IntrospectedSchema, IntrospectedTable } from "./types.ts"

/**
 * Read the PostgreSQL schema reachable through `driver`, normalised
 * into sumak's {@link IntrospectedSchema} shape.
 *
 * Reads:
 * - `information_schema.tables`: list user tables in the target schema.
 * - `information_schema.columns`: name, type, nullable, default.
 * - `information_schema.table_constraints` + `key_column_usage`:
 *   primary keys and unique constraints.
 * - `information_schema.referential_constraints` +
 *   `key_column_usage`: foreign keys with ON DELETE / ON UPDATE.
 *
 * `schema` defaults to `public`. To introspect a different schema,
 * pass `{ schema: "app" }`. System schemas (`pg_catalog`,
 * `information_schema`) are filtered out regardless.
 */
export async function introspectPg(
  driver: Driver,
  options: { schema?: string } = {},
): Promise<IntrospectedSchema> {
  const schema = options.schema ?? "public"

  const tables = (await driver.query(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    [schema],
  )) as { table_name: string }[]

  const columns = (await driver.query(
    `SELECT
       c.table_name,
       c.column_name,
       c.is_nullable,
       c.data_type,
       c.udt_name,
       c.column_default,
       c.character_maximum_length,
       c.numeric_precision,
       c.numeric_scale
     FROM information_schema.columns c
     WHERE c.table_schema = $1
     ORDER BY c.table_name, c.ordinal_position`,
    [schema],
  )) as {
    table_name: string
    column_name: string
    is_nullable: "YES" | "NO"
    data_type: string
    udt_name: string
    column_default: string | null
    character_maximum_length: number | null
    numeric_precision: number | null
    numeric_scale: number | null
  }[]

  const pkRows = (await driver.query(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
    [schema],
  )) as { table_name: string; column_name: string }[]
  const pkSet = new Set(pkRows.map((r) => `${r.table_name}.${r.column_name}`))

  const uqRows = (await driver.query(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = $1 AND tc.constraint_type = 'UNIQUE'`,
    [schema],
  )) as { table_name: string; column_name: string }[]
  const uqSet = new Set(uqRows.map((r) => `${r.table_name}.${r.column_name}`))

  const fkRows = (await driver.query(
    `SELECT
       kcu.table_name   AS from_table,
       kcu.column_name  AS from_column,
       ccu.table_name   AS to_table,
       ccu.column_name  AS to_column,
       rc.delete_rule   AS on_delete,
       rc.update_rule   AS on_update
     FROM information_schema.referential_constraints rc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = rc.constraint_name
      AND kcu.table_schema   = rc.constraint_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = rc.unique_constraint_name
      AND ccu.table_schema    = rc.unique_constraint_schema
     WHERE kcu.table_schema = $1`,
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
    const key = row.table_name
    const pkKey = `${row.table_name}.${row.column_name}`
    const fk = fkMap.get(pkKey)
    const col: IntrospectedColumn = {
      name: row.column_name,
      dataType: mapPgType(row.udt_name, row.column_default),
      nullable: row.is_nullable === "YES",
      isPrimaryKey: pkSet.has(pkKey),
      isUnique: uqSet.has(pkKey),
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
    if (!byTable.has(key)) byTable.set(key, [])
    byTable.get(key)!.push(col)
  }

  const out: IntrospectedTable[] = tables.map((t) => ({
    name: t.table_name,
    schema: schema === "public" ? undefined : schema,
    columns: byTable.get(t.table_name) ?? [],
  }))

  return { dialect: "pg", tables: out }
}

/**
 * PG data-type vocabulary → sumak column-factory name. A `serial` row
 * shows up as `integer` in information_schema plus a `nextval(...)`
 * default — we detect that here and emit `serial`.
 */
function mapPgType(udt: string, defaultExpr: string | null): string {
  const t = udt.toLowerCase()
  if ((t === "int4" || t === "integer") && defaultExpr?.startsWith("nextval(")) return "serial"
  if (t === "int8" && defaultExpr?.startsWith("nextval(")) return "bigserial"
  switch (t) {
    case "int2":
      return "smallint"
    case "int4":
      return "integer"
    case "int8":
      return "bigint"
    case "float4":
      return "real"
    case "float8":
      return "doublePrecision"
    case "bool":
      return "boolean"
    case "varchar":
      return "varchar"
    case "bpchar":
      return "char"
    case "text":
      return "text"
    case "timestamp":
      return "timestamp"
    case "timestamptz":
      return "timestamptz"
    case "date":
      return "date"
    case "time":
      return "time"
    case "interval":
      return "interval"
    case "uuid":
      return "uuid"
    case "json":
      return "json"
    case "jsonb":
      return "jsonb"
    case "bytea":
      return "bytea"
    case "numeric":
      return "numeric"
    default:
      return t
  }
}
