import type { Driver } from "../driver/types.ts"
import type {
  IntrospectedColumn,
  IntrospectedConstraints,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
} from "./types.ts"

/**
 * Read a SQL Server schema via the INFORMATION_SCHEMA + sys catalog
 * views. MSSQL's SERIAL analog is IDENTITY; we detect it via
 * `sys.columns.is_identity`. Constraints (composite PK/UQ, CHECKs,
 * composite FKs) and named indexes round-trip via the sys catalog.
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

  // Composite PK / UNIQUE — group by constraint name + ordinal_position
  // so multi-column keys come out with their columns in declared order.
  const keyRows = (await driver.query(
    `SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE,
            kcu.COLUMN_NAME, kcu.ORDINAL_POSITION
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        AND kcu.TABLE_SCHEMA    = tc.TABLE_SCHEMA
       WHERE tc.TABLE_SCHEMA = @p0
         AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
       ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    [schema],
  )) as {
    TABLE_NAME: string
    CONSTRAINT_NAME: string
    CONSTRAINT_TYPE: "PRIMARY KEY" | "UNIQUE"
    COLUMN_NAME: string
    ORDINAL_POSITION: number
  }[]
  const pkByTable = new Map<string, { name: string; columns: string[] }>()
  const uqSingle = new Set<string>()
  const uqCompositeByTable = new Map<string, Array<{ name: string; columns: string[] }>>()
  const pkSet = new Set<string>()
  const uqGroups = new Map<string, Map<string, string[]>>()
  const pkAgg = new Map<string, { name: string; columns: string[] }>()
  for (const r of keyRows) {
    if (r.CONSTRAINT_TYPE === "PRIMARY KEY") {
      let g = pkAgg.get(r.TABLE_NAME)
      if (!g) {
        g = { name: r.CONSTRAINT_NAME, columns: [] }
        pkAgg.set(r.TABLE_NAME, g)
      }
      g.columns.push(r.COLUMN_NAME)
      pkSet.add(`${r.TABLE_NAME}.${r.COLUMN_NAME}`)
    } else {
      if (!uqGroups.has(r.TABLE_NAME)) uqGroups.set(r.TABLE_NAME, new Map())
      const byName = uqGroups.get(r.TABLE_NAME)!
      if (!byName.has(r.CONSTRAINT_NAME)) byName.set(r.CONSTRAINT_NAME, [])
      byName.get(r.CONSTRAINT_NAME)!.push(r.COLUMN_NAME)
    }
  }
  for (const [table, g] of pkAgg) pkByTable.set(table, g)
  for (const [table, groups] of uqGroups) {
    for (const [name, cols] of groups) {
      if (cols.length === 1) {
        uqSingle.add(`${table}.${cols[0]!}`)
      } else {
        if (!uqCompositeByTable.has(table)) uqCompositeByTable.set(table, [])
        uqCompositeByTable.get(table)!.push({ name, columns: cols })
      }
    }
  }

  // CHECK constraints — sys.check_constraints gives us the definition
  // body directly. Joining via sys.objects gets us the parent table.
  const checkRows = (await driver.query(
    `SELECT o.name AS table_name, cc.name AS constraint_name, cc.definition AS def
       FROM sys.check_constraints cc
       JOIN sys.objects o ON o.object_id = cc.parent_object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = @p0
       ORDER BY o.name, cc.name`,
    [schema],
  )) as { table_name: string; constraint_name: string; def: string }[]
  const checksByTable = new Map<string, Array<{ name: string; expression: string }>>()
  for (const r of checkRows) {
    if (!checksByTable.has(r.table_name)) checksByTable.set(r.table_name, [])
    checksByTable
      .get(r.table_name)!
      .push({ name: r.constraint_name, expression: stripOuterParens(r.def) })
  }

  // FK columns — grouped by (parent table, constraint name) so composite
  // FKs round-trip with their columns in key_index order.
  const fkRows = (await driver.query(
    `SELECT
       OBJECT_NAME(fk.parent_object_id)          AS from_table,
       fk.name                                   AS constraint_name,
       COL_NAME(fkc.parent_object_id, fkc.parent_column_id)       AS from_column,
       fkc.constraint_column_id                  AS position,
       OBJECT_NAME(fk.referenced_object_id)      AS to_table,
       COL_NAME(fk.referenced_object_id, fkc.referenced_column_id) AS to_column,
       fk.delete_referential_action_desc          AS on_delete,
       fk.update_referential_action_desc          AS on_update
     FROM sys.foreign_keys fk
     JOIN sys.foreign_key_columns fkc
       ON fkc.constraint_object_id = fk.object_id
     WHERE SCHEMA_NAME(fk.schema_id) = @p0
     ORDER BY OBJECT_NAME(fk.parent_object_id), fk.name, fkc.constraint_column_id`,
    [schema],
  )) as {
    from_table: string
    constraint_name: string
    from_column: string
    position: number
    to_table: string
    to_column: string
    on_delete: string
    on_update: string
  }[]
  const fkMap = new Map<string, (typeof fkRows)[number]>()
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
  for (const r of fkRows) {
    const key = `${r.from_table}.${r.from_column}`
    // First entry for a column wins — sufficient for single-column FK
    // resolution; composite FKs are reconstructed from fkGroups below.
    if (!fkMap.has(key)) fkMap.set(key, r)
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

  // Named indexes — skip PK/UQ-constraint-backed ones (is_primary_key
  // or is_unique_constraint). Group by index + order columns by key_ordinal
  // so composites come out right.
  const indexRows = (await driver.query(
    `SELECT
       OBJECT_NAME(i.object_id) AS table_name,
       i.name                   AS index_name,
       i.is_unique              AS is_unique,
       i.type_desc              AS type_desc,
       i.has_filter             AS has_filter,
       i.filter_definition      AS filter_definition,
       COL_NAME(ic.object_id, ic.column_id) AS column_name,
       ic.key_ordinal           AS key_ordinal
     FROM sys.indexes i
     JOIN sys.objects o ON o.object_id = i.object_id
     JOIN sys.schemas s ON s.schema_id = o.schema_id
     LEFT JOIN sys.index_columns ic
       ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      AND ic.is_included_column = 0
     WHERE s.name = @p0
       AND o.type = 'U'
       AND i.is_primary_key = 0
       AND i.is_unique_constraint = 0
       AND i.name IS NOT NULL
     ORDER BY OBJECT_NAME(i.object_id), i.name, ic.key_ordinal`,
    [schema],
  )) as {
    table_name: string
    index_name: string
    is_unique: boolean
    type_desc: string
    has_filter: boolean
    filter_definition: string | null
    column_name: string | null
    key_ordinal: number | null
  }[]
  const indexGroups = new Map<string, Map<string, IntrospectedIndex & { columns: string[] }>>()
  for (const r of indexRows) {
    if (!r.column_name) continue
    if (!indexGroups.has(r.table_name)) indexGroups.set(r.table_name, new Map())
    const byName = indexGroups.get(r.table_name)!
    let g = byName.get(r.index_name)
    if (!g) {
      g = { name: r.index_name, columns: [], unique: r.is_unique }
      if (r.type_desc && r.type_desc.toUpperCase() !== "NONCLUSTERED") {
        ;(g as { using?: string }).using = r.type_desc.toLowerCase()
      }
      if (r.has_filter && r.filter_definition) {
        ;(g as { where?: string }).where = stripOuterParens(r.filter_definition)
      }
      byName.set(r.index_name, g)
    }
    g.columns.push(r.column_name)
  }
  const indexesByTable = new Map<string, IntrospectedIndex[]>()
  for (const [table, groups] of indexGroups) {
    const list: IntrospectedIndex[] = [...groups.values()]
    if (list.length > 0) indexesByTable.set(table, list)
  }

  const byTable = new Map<string, IntrospectedColumn[]>()
  for (const row of columns) {
    const pkKey = `${row.TABLE_NAME}.${row.COLUMN_NAME}`
    const fk = fkMap.get(pkKey)
    const col: IntrospectedColumn = {
      name: row.COLUMN_NAME,
      dataType: mapMssqlType(row.DATA_TYPE, row.is_identity === 1),
      nullable: row.IS_NULLABLE === "YES",
      isPrimaryKey: pkSet.has(pkKey) && (pkByTable.get(row.TABLE_NAME)?.columns.length ?? 0) === 1,
      isUnique: uqSingle.has(pkKey),
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

  const out: IntrospectedTable[] = tables.map((t) => {
    const name = t.TABLE_NAME
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
      schema: schema === "dbo" ? undefined : schema,
      columns: byTable.get(name) ?? [],
    }
    if (constraints) (entry as { constraints?: IntrospectedConstraints }).constraints = constraints
    if (indexes && indexes.length > 0) {
      ;(entry as { indexes?: readonly IntrospectedIndex[] }).indexes = indexes
    }
    return entry
  })
  return { dialect: "mssql", tables: out }
}

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
 * MSSQL's CHECK / filter definitions come back wrapped in parens
 * (often doubled): `((price > 0))`. Strip one balanced outer layer so
 * the expression matches what a schema author would have typed.
 */
function stripOuterParens(expr: string): string {
  let e = expr.trim()
  for (let i = 0; i < 2; i++) {
    if (!e.startsWith("(") || !e.endsWith(")")) return e
    let depth = 0
    let balanced = true
    for (let j = 0; j < e.length; j++) {
      const c = e[j]!
      if (c === "(") depth++
      else if (c === ")") {
        depth--
        if (depth === 0 && j !== e.length - 1) {
          balanced = false
          break
        }
      }
    }
    if (!balanced) return e
    e = e.slice(1, -1).trim()
  }
  return e
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
