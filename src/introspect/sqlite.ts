import type { Driver } from "../driver/types.ts"
import type {
  IntrospectedColumn,
  IntrospectedConstraints,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
} from "./types.ts"

/**
 * Read a SQLite schema via the `sqlite_master` / `PRAGMA` channels.
 *
 * SQLite's introspection story is pragma-based: there's no
 * `information_schema`. We list tables from `sqlite_master`, then use
 * `PRAGMA table_info(t)` / `table_xinfo(t)` for columns,
 * `PRAGMA foreign_key_list(t)` for FKs, `PRAGMA index_list(t)` +
 * `index_info(t)` for uniques and named indexes. Composite primary
 * keys come from `table_info.pk` > 0. CHECK constraints have no
 * pragma — we parse them from the DDL stored in `sqlite_master.sql`.
 */
export async function introspectSqlite(driver: Driver): Promise<IntrospectedSchema> {
  const tables = (await driver.query(
    `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    [],
  )) as { name: string; sql: string | null }[]

  const out: IntrospectedTable[] = []
  for (const t of tables) {
    const cols = (await driver.query(`PRAGMA table_info(${quote(t.name)})`, [])) as {
      cid: number
      name: string
      type: string
      notnull: 0 | 1
      dflt_value: string | null
      // 0 = not PK, >0 = position in composite PK (1-based).
      pk: number
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
    const indexRows = (await driver.query(`PRAGMA index_list(${quote(t.name)})`, [])) as {
      seq: number
      name: string
      unique: 0 | 1
      // 'c' = user CREATE INDEX, 'u' = UNIQUE constraint-backed,
      // 'pk' = implicit PK index.
      origin: "c" | "u" | "pk"
      partial: 0 | 1
    }[]

    // Walk each index row, fetch its columns, and bucket:
    //  - origin === 'u' + 1 column → column-level isUnique
    //  - origin === 'u' + N cols   → composite unique constraint
    //  - origin === 'c'            → named index (possibly unique)
    //  - origin === 'pk'           → implicit PK index (skip; pragma.pk covers it)
    const uniqueSet = new Set<string>()
    const compositeUniques: Array<{ name: string; columns: string[] }> = []
    const namedIndexes: IntrospectedIndex[] = []
    for (const idx of indexRows) {
      if (idx.origin === "pk") continue
      const info = (await driver.query(`PRAGMA index_info(${quote(idx.name)})`, [])) as {
        seqno: number
        cid: number
        name: string
      }[]
      const colNames = info
        .slice()
        .sort((a, b) => a.seqno - b.seqno)
        .map((r) => r.name)
      if (idx.origin === "u") {
        if (colNames.length === 1) uniqueSet.add(colNames[0]!)
        else compositeUniques.push({ name: idx.name, columns: colNames })
      } else {
        namedIndexes.push({ name: idx.name, columns: colNames, unique: idx.unique === 1 })
      }
    }

    // Composite PK: if the table has >1 column with pk>0, lift them to
    // a table-level primary key constraint and strip the per-column
    // `isPrimaryKey` — the canonical location is the constraint entry.
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)

    // FK grouping by `id` — composite FKs share an id across rows.
    const fkById = new Map<number, (typeof fks)[number][]>()
    for (const fk of fks) {
      if (!fkById.has(fk.id)) fkById.set(fk.id, [])
      fkById.get(fk.id)!.push(fk)
    }
    const fkSingle = new Map<string, (typeof fks)[number]>()
    const compositeFks: Array<{
      columns: readonly string[]
      references: { table: string; columns: readonly string[] }
      onDelete?: string
      onUpdate?: string
    }> = []
    for (const group of fkById.values()) {
      const sorted = group.slice().sort((a, b) => a.seq - b.seq)
      if (sorted.length === 1) {
        fkSingle.set(sorted[0]!.from, sorted[0]!)
      } else {
        compositeFks.push({
          columns: sorted.map((g) => g.from),
          references: { table: sorted[0]!.table, columns: sorted.map((g) => g.to) },
          onDelete: sorted[0]!.on_delete,
          onUpdate: sorted[0]!.on_update,
        })
      }
    }

    // CHECK constraints — not exposed via pragma. Parse the original
    // DDL stored in `sqlite_master.sql`. We pull every `CHECK (...)`
    // clause at top-level (balanced-paren-aware) and associate it with
    // either a column (inline) or the table (trailing). The inline vs.
    // table distinction is lost once in sumak's `IntrospectedConstraints`
    // shape — we surface them all as table-level entries and let the
    // generator apply them at table scope.
    const checks = t.sql ? extractChecks(t.sql) : []

    const columns: IntrospectedColumn[] = cols.map((c) => {
      const fk = fkSingle.get(c.name)
      return {
        name: c.name,
        dataType: mapSqliteType(c.type),
        nullable: c.notnull === 0,
        isPrimaryKey: pkCols.length === 1 && c.pk === 1,
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

    const constraints: Writable<IntrospectedConstraints> = {}
    if (pkCols.length > 1) constraints.primaryKey = { columns: pkCols }
    if (compositeUniques.length > 0) constraints.uniques = compositeUniques
    if (checks.length > 0) constraints.checks = checks
    if (compositeFks.length > 0) constraints.foreignKeys = compositeFks

    const entry: IntrospectedTable = { name: t.name, columns }
    if (Object.keys(constraints).length > 0) {
      ;(entry as { constraints?: IntrospectedConstraints }).constraints = constraints
    }
    if (namedIndexes.length > 0) {
      ;(entry as { indexes?: readonly IntrospectedIndex[] }).indexes = namedIndexes
    }
    out.push(entry)
  }

  return { dialect: "sqlite", tables: out }
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Find all top-level `CHECK (...)` clauses in a CREATE TABLE DDL and
 * return their bodies. Uses a paren-depth scan so expressions with
 * nested parens survive. We skip quoted strings and identifiers so
 * `CHECK` inside a string literal doesn't confuse us.
 *
 * The result has no `name` — SQLite lets you write
 * `CONSTRAINT nm CHECK (...)`; we don't try to recover that here
 * because the raw DDL might not normalise whitespace consistently.
 */
function extractChecks(ddl: string): Array<{ expression: string }> {
  const out: Array<{ expression: string }> = []
  let i = 0
  while (i < ddl.length) {
    const rest = ddl.slice(i)
    const m = /\bCHECK\s*\(/i.exec(rest)
    if (!m) break
    const start = i + m.index + m[0].length
    // Skip if this CHECK sits inside a string/identifier literal.
    if (insideLiteral(ddl, i + m.index)) {
      i = i + m.index + 1
      continue
    }
    let depth = 1
    let j = start
    while (j < ddl.length && depth > 0) {
      const c = ddl[j]!
      if (c === "'" || c === '"' || c === "`") {
        const end = skipLiteral(ddl, j)
        j = end
        continue
      }
      if (c === "(") depth++
      else if (c === ")") depth--
      j++
    }
    if (depth === 0) {
      out.push({ expression: ddl.slice(start, j - 1).trim() })
      i = j
    } else {
      break
    }
  }
  return out
}

function insideLiteral(s: string, idx: number): boolean {
  let inStr: string | null = null
  for (let i = 0; i < idx; i++) {
    const c = s[i]!
    if (inStr) {
      if (c === inStr && s[i + 1] === inStr) {
        i++
        continue
      }
      if (c === inStr) inStr = null
    } else if (c === "'" || c === '"' || c === "`") {
      inStr = c
    }
  }
  return inStr !== null
}

function skipLiteral(s: string, start: number): number {
  const quote = s[start]!
  let i = start + 1
  while (i < s.length) {
    const c = s[i]!
    if (c === quote) {
      if (s[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return i
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
