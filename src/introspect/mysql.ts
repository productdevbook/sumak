import type { Driver } from "../driver/types.ts"
import type {
  IntrospectedColumn,
  IntrospectedConstraints,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
} from "./types.ts"

/**
 * Read a MySQL database's schema from the driver, normalised to the
 * shared {@link IntrospectedSchema} shape.
 *
 * Queries `information_schema.tables`, `columns`, `key_column_usage`,
 * `referential_constraints`, `table_constraints`, `check_constraints`,
 * and `statistics` (for indexes). MySQL reports PRIMARY/UNIQUE on the
 * column rows too (via COLUMN_KEY = 'PRI' / 'UNI'), so single-column
 * key detection is slightly cheaper than on PG — but composite keys
 * and CHECKs still round-trip via the table-level catalog.
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
       kcu.constraint_name       AS constraint_name,
       kcu.ordinal_position      AS ordinal_position,
       kcu.referenced_table_name AS to_table,
       kcu.referenced_column_name AS to_column,
       rc.delete_rule            AS on_delete,
       rc.update_rule            AS on_update
     FROM information_schema.key_column_usage kcu
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name   = kcu.constraint_name
      AND rc.constraint_schema = kcu.constraint_schema
     WHERE kcu.referenced_table_name IS NOT NULL ${dbClause.replace(/table_schema/g, "kcu.table_schema")}
     ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position`,
    params,
  )) as {
    from_table: string
    from_column: string
    constraint_name: string
    ordinal_position: number
    to_table: string
    to_column: string
    on_delete: string
    on_update: string
  }[]
  const fkMap = new Map<string, (typeof fks)[number]>()
  for (const r of fks) {
    // Column-level FK lookup only makes sense for single-column FKs; if
    // the same column participates in multiple FKs, the first wins.
    const key = `${r.from_table}.${r.from_column}`
    if (!fkMap.has(key)) fkMap.set(key, r)
  }
  // Group FK columns by constraint for composite-FK reconstruction.
  const fkGroups = new Map<
    string,
    Map<
      string,
      {
        name: string
        columns: string[]
        to_table: string
        to_columns: string[]
        on_delete: string
        on_update: string
      }
    >
  >()
  for (const r of fks) {
    if (!fkGroups.has(r.from_table)) fkGroups.set(r.from_table, new Map())
    const byName = fkGroups.get(r.from_table)!
    let g = byName.get(r.constraint_name)
    if (!g) {
      g = {
        name: r.constraint_name,
        columns: [],
        to_table: r.to_table,
        to_columns: [],
        on_delete: r.on_delete,
        on_update: r.on_update,
      }
      byName.set(r.constraint_name, g)
    }
    g.columns.push(r.from_column)
    g.to_columns.push(r.to_column)
  }

  // Primary-key and UNIQUE constraints — group columns by constraint
  // name so composite keys round-trip. PRIMARY is always named PRIMARY
  // in MySQL; UNIQUE constraints get their explicit names.
  const keyRows = (await driver.query(
    `SELECT tc.table_name, tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name   = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
        AND kcu.table_name        = tc.table_name
       WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
         ${dbClause.replace(/table_schema/g, "tc.table_schema")}
       ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
    params,
  )) as {
    table_name: string
    constraint_name: string
    constraint_type: "PRIMARY KEY" | "UNIQUE"
    column_name: string
    ordinal_position: number
  }[]
  const pkByTable = new Map<string, { name: string; columns: string[] }>()
  const uqCompositeByTable = new Map<string, Array<{ name: string; columns: string[] }>>()
  const uqSingleColumn = new Set<string>()
  const uqGroups = new Map<string, Map<string, string[]>>()
  const pkGroups = new Map<string, string[]>()
  for (const r of keyRows) {
    if (r.constraint_type === "PRIMARY KEY") {
      if (!pkGroups.has(r.table_name)) pkGroups.set(r.table_name, [])
      pkGroups.get(r.table_name)!.push(r.column_name)
      pkByTable.set(r.table_name, { name: r.constraint_name, columns: pkGroups.get(r.table_name)! })
    } else {
      if (!uqGroups.has(r.table_name)) uqGroups.set(r.table_name, new Map())
      const byName = uqGroups.get(r.table_name)!
      if (!byName.has(r.constraint_name)) byName.set(r.constraint_name, [])
      byName.get(r.constraint_name)!.push(r.column_name)
    }
  }
  for (const [table, groups] of uqGroups) {
    for (const [name, cols] of groups) {
      if (cols.length === 1) {
        uqSingleColumn.add(`${table}.${cols[0]!}`)
      } else {
        if (!uqCompositeByTable.has(table)) uqCompositeByTable.set(table, [])
        uqCompositeByTable.get(table)!.push({ name, columns: cols })
      }
    }
  }

  // CHECK constraints landed in 8.0.16 via
  // information_schema.check_constraints. On older versions this SELECT
  // will fail — we swallow the error so the rest of introspection still
  // succeeds, and simply report no CHECKs.
  const checksByTable = new Map<string, Array<{ name: string; expression: string }>>()
  try {
    const checkRows = (await driver.query(
      `SELECT cc.constraint_name, cc.check_clause, tc.table_name
         FROM information_schema.check_constraints cc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name   = cc.constraint_name
          AND tc.constraint_schema = cc.constraint_schema
         WHERE tc.constraint_type = 'CHECK'
           ${dbClause.replace(/table_schema/g, "tc.table_schema")}
         ORDER BY tc.table_name, cc.constraint_name`,
      params,
    )) as { constraint_name: string; check_clause: string; table_name: string }[]
    for (const r of checkRows) {
      if (!checksByTable.has(r.table_name)) checksByTable.set(r.table_name, [])
      checksByTable
        .get(r.table_name)!
        .push({ name: r.constraint_name, expression: stripOuterParens(r.check_clause) })
    }
  } catch {
    // check_constraints view missing (MySQL < 8.0.16 / older MariaDB).
  }

  // Indexes — skip PRIMARY and UNIQUE-constraint-backed indexes; those
  // round-trip via `constraints`. Group rows by (table, index_name) and
  // order columns by `seq_in_index` so composite indexes come out right.
  const indexRows = (await driver.query(
    `SELECT s.table_name, s.index_name, s.column_name, s.seq_in_index,
            s.non_unique, s.index_type
       FROM information_schema.statistics s
       WHERE s.index_name <> 'PRIMARY'
         ${dbClause.replace(/table_schema/g, "s.table_schema")}
       ORDER BY s.table_name, s.index_name, s.seq_in_index`,
    params,
  )) as {
    table_name: string
    index_name: string
    column_name: string
    seq_in_index: number
    non_unique: 0 | 1
    index_type: string
  }[]
  // Build a set of UNIQUE-constraint index names (those we want to skip)
  // — in MySQL the UNIQUE constraint and its backing index share a name.
  const uqIndexNames = new Set<string>()
  for (const [table, groups] of uqGroups) {
    for (const name of groups.keys()) uqIndexNames.add(`${table}.${name}`)
  }
  const indexesByTable = new Map<string, IntrospectedIndex[]>()
  const indexGroups = new Map<string, Map<string, IntrospectedIndex & { columns: string[] }>>()
  for (const r of indexRows) {
    if (uqIndexNames.has(`${r.table_name}.${r.index_name}`)) continue
    if (!indexGroups.has(r.table_name)) indexGroups.set(r.table_name, new Map())
    const byName = indexGroups.get(r.table_name)!
    let g = byName.get(r.index_name)
    if (!g) {
      g = { name: r.index_name, columns: [], unique: r.non_unique === 0 }
      if (r.index_type && r.index_type.toUpperCase() !== "BTREE") {
        ;(g as { using?: string }).using = r.index_type.toLowerCase()
      }
      byName.set(r.index_name, g)
    }
    g.columns.push(r.column_name)
  }
  for (const [table, groups] of indexGroups) {
    const list: IntrospectedIndex[] = [...groups.values()]
    if (list.length > 0) indexesByTable.set(table, list)
  }

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
      isUnique: row.column_key === "UNI" || uqSingleColumn.has(pkKey),
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

  const out: IntrospectedTable[] = tables.map((t) => {
    const name = t.table_name
    const constraints = buildConstraints(
      name,
      pkByTable,
      uqCompositeByTable,
      checksByTable,
      fkGroups,
    )
    const indexes = indexesByTable.get(name)
    const entry: IntrospectedTable = {
      name,
      columns: byTable.get(name) ?? [],
    }
    if (constraints) (entry as { constraints?: IntrospectedConstraints }).constraints = constraints
    if (indexes && indexes.length > 0) {
      ;(entry as { indexes?: readonly IntrospectedIndex[] }).indexes = indexes
    }
    return entry
  })
  return { dialect: "mysql", tables: out }
}

/**
 * Compose the per-table `IntrospectedConstraints` value from the
 * catalog lookups. Single-column PRIMARY/UNIQUE already flow through
 * the per-column `isPrimaryKey` / `isUnique` flags; this function only
 * fills composite PK, composite/named UNIQUE, CHECK, and composite FK.
 */
function buildConstraints(
  table: string,
  pk: Map<string, { name: string; columns: string[] }>,
  uqComposite: Map<string, Array<{ name: string; columns: string[] }>>,
  checks: Map<string, Array<{ name: string; expression: string }>>,
  fks: Map<
    string,
    Map<
      string,
      {
        name: string
        columns: string[]
        to_table: string
        to_columns: string[]
        on_delete: string
        on_update: string
      }
    >
  >,
): IntrospectedConstraints | undefined {
  const pkEntry = pk.get(table)
  const uqs = uqComposite.get(table)
  const cks = checks.get(table)
  const fkByName = fks.get(table)

  type FkEntry = {
    name?: string
    columns: readonly string[]
    references: { table: string; columns: readonly string[] }
    onDelete?: string
    onUpdate?: string
  }
  const compositeFks: FkEntry[] = []
  if (fkByName) {
    for (const fk of fkByName.values()) {
      if (fk.columns.length === 1) continue
      compositeFks.push({
        name: fk.name,
        columns: [...fk.columns],
        references: { table: fk.to_table, columns: [...fk.to_columns] },
        onDelete: fk.on_delete,
        onUpdate: fk.on_update,
      })
    }
  }

  const hasAnything =
    pkEntry !== undefined ||
    (uqs && uqs.length > 0) ||
    (cks && cks.length > 0) ||
    compositeFks.length > 0
  if (!hasAnything) return undefined

  const out: Writable<IntrospectedConstraints> = {}
  if (pkEntry) {
    out.primaryKey =
      pkEntry.columns.length === 1
        ? { columns: [...pkEntry.columns] }
        : { name: pkEntry.name, columns: [...pkEntry.columns] }
  }
  if (uqs && uqs.length > 0)
    out.uniques = uqs.map((u) => ({ name: u.name, columns: [...u.columns] }))
  if (cks && cks.length > 0)
    out.checks = cks.map((c) => ({ name: c.name, expression: c.expression }))
  if (compositeFks.length > 0) out.foreignKeys = compositeFks
  return out
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * MySQL's `check_clause` is already the body expression — but some
 * servers wrap it in outer parens. Peel one balanced layer if present
 * so it matches what a schema author would have typed.
 */
function stripOuterParens(expr: string): string {
  const e = expr.trim()
  if (!e.startsWith("(") || !e.endsWith(")")) return e
  let depth = 0
  for (let i = 0; i < e.length; i++) {
    const c = e[i]!
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0 && i !== e.length - 1) return e
    }
  }
  return e.slice(1, -1).trim()
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
