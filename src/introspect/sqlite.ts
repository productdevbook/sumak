import type { Driver } from "../driver/types.ts"
import type { IntrospectedColumn, IntrospectedSchema, IntrospectedTable } from "./types.ts"

/**
 * Read a SQLite schema via the `sqlite_master` / `PRAGMA` channels.
 *
 * SQLite's introspection story is pragma-based: there's no
 * `information_schema`. We list tables from `sqlite_master`, then use
 * `PRAGMA table_info(t)` for columns and `PRAGMA foreign_key_list(t)`
 * for FKs. The `PRAGMA` tables surface as normal rows via the driver.
 */
export async function introspectSqlite(driver: Driver): Promise<IntrospectedSchema> {
  const tables = (await driver.query(
    `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    [],
  )) as { name: string }[]

  const out: IntrospectedTable[] = []
  for (const t of tables) {
    const cols = (await driver.query(`PRAGMA table_info(${quote(t.name)})`, [])) as {
      cid: number
      name: string
      type: string
      notnull: 0 | 1
      dflt_value: string | null
      pk: 0 | 1
    }[]
    const fks = (await driver.query(`PRAGMA foreign_key_list(${quote(t.name)})`, [])) as {
      id: number
      seq: number
      table: string
      from: string
      to: string
      on_update: string
      on_delete: string
      match: string
    }[]
    const uniqueRows = (await driver.query(`PRAGMA index_list(${quote(t.name)})`, [])) as {
      seq: number
      name: string
      unique: 0 | 1
      origin: "c" | "u" | "pk"
      partial: 0 | 1
    }[]
    const uniqueSet = new Set<string>()
    for (const idx of uniqueRows.filter((i) => i.unique === 1 && i.origin !== "pk")) {
      const info = (await driver.query(`PRAGMA index_info(${quote(idx.name)})`, [])) as {
        seqno: number
        cid: number
        name: string
      }[]
      if (info.length === 1) uniqueSet.add(info[0]!.name)
    }
    const fkMap = new Map<string, (typeof fks)[number]>()
    for (const fk of fks) fkMap.set(fk.from, fk)

    const columns: IntrospectedColumn[] = cols.map((c) => {
      const fk = fkMap.get(c.name)
      return {
        name: c.name,
        dataType: mapSqliteType(c.type),
        nullable: c.notnull === 0,
        isPrimaryKey: c.pk === 1,
        isUnique: uniqueSet.has(c.name),
        defaultExpression: c.dflt_value ?? undefined,
        references: fk
          ? {
              table: fk.table,
              column: fk.to,
              onDelete: fk.on_delete,
              onUpdate: fk.on_update,
            }
          : undefined,
      }
    })
    out.push({ name: t.name, columns })
  }

  return { dialect: "sqlite", tables: out }
}

function quote(name: string): string {
  // PRAGMA names aren't parameter-able. Guard with a strict whitelist.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`introspectSqlite: refusing unsafe table name ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}

function mapSqliteType(declared: string): string {
  const t = declared.toLowerCase()
  // SQLite's storage classes are INTEGER, REAL, TEXT, BLOB, NUMERIC.
  // Declared column types are mostly affinity-only. Best-effort mapping:
  if (t.includes("int")) return "integer"
  if (t.includes("char") || t.includes("text") || t.includes("clob")) return "text"
  if (t.includes("real") || t.includes("floa") || t.includes("doub")) return "doublePrecision"
  if (t.includes("blob")) return "bytea"
  if (t.includes("bool")) return "boolean"
  if (t === "") return "text"
  return t
}
