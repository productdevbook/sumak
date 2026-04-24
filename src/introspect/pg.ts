import type { Driver } from "../driver/types.ts"
import type {
  IntrospectedColumn,
  IntrospectedConstraints,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
} from "./types.ts"

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
    `SELECT tc.table_name, tc.constraint_name, kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY tc.table_name, kcu.ordinal_position`,
    [schema],
  )) as {
    table_name: string
    constraint_name: string
    column_name: string
    ordinal_position: number
  }[]
  const pkSet = new Set(pkRows.map((r) => `${r.table_name}.${r.column_name}`))
  const pkByTable = new Map<string, { name: string; columns: string[] }>()
  for (const r of pkRows) {
    let g = pkByTable.get(r.table_name)
    if (!g) {
      g = { name: r.constraint_name, columns: [] }
      pkByTable.set(r.table_name, g)
    }
    g.columns.push(r.column_name)
  }

  const uqRows = (await driver.query(
    `SELECT tc.table_name, tc.constraint_name, kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = $1 AND tc.constraint_type = 'UNIQUE'
       ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
    [schema],
  )) as {
    table_name: string
    constraint_name: string
    column_name: string
    ordinal_position: number
  }[]
  // For column-level `isUnique` we only flag columns that sit alone in
  // a UNIQUE constraint. Composite uniques round-trip as table-level
  // `IntrospectedConstraints.uniques`.
  const uqGroups = new Map<string, Map<string, string[]>>()
  for (const r of uqRows) {
    if (!uqGroups.has(r.table_name)) uqGroups.set(r.table_name, new Map())
    const byName = uqGroups.get(r.table_name)!
    if (!byName.has(r.constraint_name)) byName.set(r.constraint_name, [])
    byName.get(r.constraint_name)!.push(r.column_name)
  }
  const uqSet = new Set<string>()
  const uqCompositeByTable = new Map<string, Array<{ name: string; columns: string[] }>>()
  for (const [table, groups] of uqGroups) {
    for (const [name, cols] of groups) {
      if (cols.length === 1) {
        uqSet.add(`${table}.${cols[0]!}`)
      } else {
        if (!uqCompositeByTable.has(table)) uqCompositeByTable.set(table, [])
        uqCompositeByTable.get(table)!.push({ name, columns: cols })
      }
    }
  }

  // CHECK constraints — names + body. `pg_get_constraintdef` emits the
  // full `CHECK (<expr>)` form; we strip the outer wrapper so the body
  // matches what schema authors would write in a `CheckDef.expression`.
  const checkRows = (await driver.query(
    `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def, r.relname AS table_name
       FROM pg_catalog.pg_constraint c
       JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = $1 AND c.contype = 'c'
       ORDER BY r.relname, c.conname`,
    [schema],
  )) as { name: string; def: string; table_name: string }[]
  const checksByTable = new Map<string, Array<{ name: string; expression: string }>>()
  for (const r of checkRows) {
    const expr = stripCheckWrapper(r.def)
    if (!checksByTable.has(r.table_name)) checksByTable.set(r.table_name, [])
    checksByTable.get(r.table_name)!.push({ name: r.name, expression: expr })
  }

  // Indexes — only non-PK and non-UNIQUE-constraint indexes. PK and
  // UNIQUE indexes are already round-tripped via constraints; emitting
  // them again here would cause drift when re-applying the schema.
  const indexRows = (await driver.query(
    `SELECT
       i.relname   AS index_name,
       t.relname   AS table_name,
       ix.indisunique AS is_unique,
       pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
       am.amname   AS using_method,
       ARRAY(
         SELECT a.attname
           FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
           ORDER BY k.ord
       ) AS columns
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_am am ON am.oid = i.relam
     LEFT JOIN pg_constraint con ON con.conindid = i.oid
     WHERE n.nspname = $1 AND con.oid IS NULL
     ORDER BY t.relname, i.relname`,
    [schema],
  )) as {
    index_name: string
    table_name: string
    is_unique: boolean
    predicate: string | null
    using_method: string
    columns: string[]
  }[]
  // pg_index + the "indexdef" join above produces one row per index.
  // `predicate` is the WHERE body; `using_method` is the am (btree,
  // gin, hash, ...). We keep `using` only when it's non-btree so the
  // common case round-trips without noise.
  const indexesByTable = new Map<string, IntrospectedIndex[]>()
  for (const r of indexRows) {
    const idx: IntrospectedIndex = {
      name: r.index_name,
      columns: [...r.columns],
      unique: r.is_unique,
    }
    if (r.using_method && r.using_method !== "btree") {
      ;(idx as { using?: string }).using = r.using_method
    }
    if (r.predicate) (idx as { where?: string }).where = r.predicate
    if (!indexesByTable.has(r.table_name)) indexesByTable.set(r.table_name, [])
    indexesByTable.get(r.table_name)!.push(idx)
  }

  const fkRows = (await driver.query(
    `SELECT
       rc.constraint_name AS constraint_name,
       kcu.table_name     AS from_table,
       kcu.column_name    AS from_column,
       kcu.ordinal_position,
       ccu.table_name     AS to_table,
       ccu.column_name    AS to_column,
       rc.delete_rule     AS on_delete,
       rc.update_rule     AS on_update
     FROM information_schema.referential_constraints rc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = rc.constraint_name
      AND kcu.table_schema   = rc.constraint_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = rc.unique_constraint_name
      AND ccu.table_schema    = rc.unique_constraint_schema
     WHERE kcu.table_schema = $1
     ORDER BY kcu.table_name, rc.constraint_name, kcu.ordinal_position`,
    [schema],
  )) as {
    constraint_name: string
    from_table: string
    from_column: string
    ordinal_position: number
    to_table: string
    to_column: string
    on_delete: string
    on_update: string
  }[]
  // Column-level `references` lookup (used by the legacy single-column
  // short form). For composite FKs we populate the table-level
  // `foreignKeys` entry instead.
  const fkMap = new Map<string, (typeof fkRows)[number]>()
  for (const r of fkRows) fkMap.set(`${r.from_table}.${r.from_column}`, r)
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
      schema: schema === "public" ? undefined : schema,
      columns: byTable.get(name) ?? [],
    }
    if (constraints) (entry as { constraints?: IntrospectedConstraints }).constraints = constraints
    if (indexes && indexes.length > 0) {
      ;(entry as { indexes?: readonly IntrospectedIndex[] }).indexes = indexes
    }
    return entry
  })

  return { dialect: "pg", tables: out }
}

/**
 * Compose the per-table `IntrospectedConstraints` value from the
 * several catalog lookups. We always set a `primaryKey` when present —
 * even a single-column PK — so the shape is consistent across tables;
 * single-column `isPrimaryKey` flags on columns are kept for legacy
 * callers but the canonical location is the table-level field.
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
        ? { columns: [...pkEntry.columns] } // single-col PK: skip the auto-generated name
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
 * `pg_get_constraintdef` returns something like `CHECK ((price > 0))`.
 * Strip the outer `CHECK ((...))` wrapper so the body matches what a
 * sumak schema author would have typed.
 */
function stripCheckWrapper(def: string): string {
  const m = /^CHECK\s*\((.*)\)\s*$/is.exec(def.trim())
  if (!m) return def.trim()
  // The inner group often has its own wrapping parens from PG. Drop one
  // layer if it's there — but leave the body untouched beyond that.
  const inner = m[1]!.trim()
  if (inner.startsWith("(") && inner.endsWith(")")) {
    // Only drop if the outer parens are balanced on their own (don't
    // strip when the body is `(a) AND (b)`). Cheap check: depth stays
    // > 0 until the final char.
    let depth = 0
    let matched = true
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]!
      if (c === "(") depth++
      else if (c === ")") {
        depth--
        if (depth === 0 && i !== inner.length - 1) {
          matched = false
          break
        }
      }
    }
    if (matched) return inner.slice(1, -1).trim()
  }
  return inner
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
