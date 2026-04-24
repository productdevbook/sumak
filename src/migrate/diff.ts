import type {
  AlterTableAction,
  AlterTableNode,
  ColumnDefinitionNode,
  CreateIndexNode,
  CreateTableNode,
  DDLNode,
  DropIndexNode,
  DropTableNode,
  TableConstraintNode,
} from "../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../ast/nodes.ts"
import { tableRef } from "../ast/nodes.ts"
import type { ColumnBuilder, ColumnDef } from "../schema/column.ts"
import { isTableDefinition, normalizeKeyDef, resolveCheckExpression } from "../schema/table.ts"
import type {
  CheckDef,
  ForeignKeyDef,
  IndexColumn,
  IndexDef,
  NormalizedTable,
  PrimaryKeyDef,
  TableConstraints,
  TableDefinition,
  UniqueDef,
} from "../schema/table.ts"

/**
 * Schema shape — the same `tables` object you'd hand to `sumak({ tables })`.
 * Accepts the legacy flat form (`{ users: { id: serial() } }`), the
 * {@link TableDefinition} form produced by `defineTable(...)`, or a
 * pre-normalized `{ columns, constraints? }` entry. The migration diff
 * operates on the union so migration input and runtime schema stay one
 * source of truth.
 */
export type SchemaDef = Record<
  string,
  | Record<string, ColumnBuilder<any, any, any>>
  | TableDefinition<string, Record<string, ColumnBuilder<any, any, any>>>
  | NormalizedTable
>

/**
 * Options for {@link diffSchemas}.
 */
export interface DiffOptions {
  /**
   * Allow destructive operations (DROP TABLE, DROP COLUMN). When false
   * (default), destructive diffs are emitted but wrapped with a
   * `destructive: true` tag, and {@link diffSchemas} throws if the
   * caller didn't opt in. The migration runner sets this to true
   * after an interactive confirmation.
   *
   * Set to "ignore" to skip destructive changes entirely — useful for
   * idempotent "ensure the schema at least has these tables" migrations.
   */
  allowDestructive?: boolean | "ignore"

  /**
   * Explicit rename declarations. Without these, a column rename
   * looks like DROP old + ADD new to the structural diff — which
   * means data loss. Pass an entry per rename to turn the pair of
   * actions into a single `ALTER TABLE … RENAME COLUMN`:
   *
   * ```ts
   * diffSchemas(before, after, {
   *   renames: {
   *     columns: { "users.old_name": "users.new_name" },
   *     tables:  { "posts": "articles" },
   *   },
   * })
   * ```
   *
   * Format: `"<table>.<column>"` for columns, `"<old_table>"` for
   * tables. Unknown keys (column not in before, target already in
   * after) are ignored with a silent no-op — the caller's migration
   * history survives schema drift between environments.
   */
  renames?: {
    /** `{ "table.old_col": "table.new_col" }`. Table is implied by the old key. */
    columns?: Record<string, string>
    /** `{ "old_table": "new_table" }`. */
    tables?: Record<string, string>
  }
}

/**
 * Compute the DDL steps that bring `before` up to `after`.
 *
 * Ordering is chosen so the migration is safe to apply as a single
 * transaction on PG:
 *   1. DROP FK constraints that reference tables about to be dropped.
 *   2. DROP columns on surviving tables.
 *   3. DROP tables no longer present.
 *   4. CREATE new tables (with their FKs; FK targets already exist by
 *      virtue of depth-first creation below).
 *   5. ADD columns to surviving tables.
 *   6. ALTER column attrs (NOT NULL, default, type) on surviving cols.
 *
 * FKs between new tables are resolved via topological ordering — a
 * table that references another new table comes after it.
 */
export function diffSchemas(
  before: SchemaDef,
  after: SchemaDef,
  opts: DiffOptions = {},
): DDLNode[] {
  const beforeNorm = normalizeSchema(before)
  const afterNorm = normalizeSchema(after)

  // Resolve explicit table renames up-front. An entry like
  // `{ tables: { posts: "articles" } }` takes the "posts" key in the
  // before map and treats it as the "articles" key for the rest of
  // the diff — plus emits an ALTER TABLE RENAME. Structural diffing
  // then compares the post-rename shape so column changes against a
  // renamed table still go through.
  const tableRenames = opts.renames?.tables ?? {}
  const renameTableNodes: DDLNode[] = []
  const beforeAfterRename: Record<string, NormalizedTable> = {}
  for (const [name, entry] of Object.entries(beforeNorm)) {
    const renamed = tableRenames[name]
    if (renamed && renamed !== name && afterNorm[renamed] && !afterNorm[name]) {
      beforeAfterRename[renamed] = entry
      renameTableNodes.push({
        type: "alter_table",
        table: tableRef(name),
        actions: [{ kind: "rename_table", to: renamed }],
      } satisfies AlterTableNode)
    } else {
      beforeAfterRename[name] = entry
    }
  }

  const beforeTables = new Set(Object.keys(beforeAfterRename))
  const afterTables = new Set(Object.keys(afterNorm))

  const removed = [...beforeTables].filter((t) => !afterTables.has(t))
  const added = [...afterTables].filter((t) => !beforeTables.has(t))
  const shared = [...afterTables].filter((t) => beforeTables.has(t))

  const destructive: DDLNode[] = []
  const additive: DDLNode[] = [...renameTableNodes]

  // ── DROP INDEXES on removed tables ────────────────────────────
  // Indexes belong to tables; dropping an index before its owning
  // table keeps the DDL replayable (and makes the intent visible in
  // the plan). Shared-table index changes are handled below per-table.
  for (const t of removed) {
    for (const idx of beforeAfterRename[t]!.indexes ?? []) {
      destructive.push({
        type: "drop_index",
        name: idx.name,
        table: t,
        ifExists: true,
      } satisfies DropIndexNode)
    }
  }

  // ── DROP TABLES ───────────────────────────────────────────────
  for (const t of removed) {
    destructive.push({
      type: "drop_table",
      table: tableRef(t),
      ifExists: true,
    } satisfies DropTableNode)
  }

  // ── CREATE TABLES (topo order by FK references) ───────────────
  const createdInOrder = topoSortForCreation(added, afterNorm)
  for (const t of createdInOrder) {
    additive.push(createTableFromSchema(t, afterNorm[t]!))
  }

  // ── CREATE INDEXES on newly added tables ──────────────────────
  for (const t of createdInOrder) {
    for (const idx of afterNorm[t]!.indexes ?? []) {
      additive.push(createIndexFromDef(t, idx))
    }
  }

  // ── ALTER (per shared table) ──────────────────────────────────
  const columnRenames = opts.renames?.columns ?? {}
  for (const t of shared) {
    const tableDiff = diffTable(t, beforeAfterRename[t]!, afterNorm[t]!, columnRenames)
    for (const n of tableDiff.destructive) destructive.push(n)
    for (const n of tableDiff.additive) additive.push(n)
  }

  // Apply the destructive-gate. `allowDestructive` defaults to false;
  // we still emit the DDL (so the caller can inspect a plan) but
  // throw unless the caller is explicit. The "ignore" mode just drops
  // them — handy for seed / dev flows where stale tables don't matter.
  if (destructive.length > 0) {
    if (opts.allowDestructive === true) {
      // OK, merge.
    } else if (opts.allowDestructive === "ignore") {
      return additive
    } else {
      throw new DestructiveMigrationError(describeDestructive(destructive))
    }
  }

  return [...destructive, ...additive]
}

/**
 * Thrown when `diffSchemas` would emit destructive operations but the
 * caller didn't opt in via `allowDestructive`. The message enumerates
 * what would be lost so the caller can make an informed decision.
 */
export class DestructiveMigrationError extends Error {
  constructor(what: string) {
    super(
      `migration contains destructive changes — pass { allowDestructive: true } to apply, ` +
        `or { allowDestructive: "ignore" } to skip. Planned drops:\n  ${what}`,
    )
    this.name = "DestructiveMigrationError"
  }
}

function describeDestructive(nodes: DDLNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "drop_table") return `DROP TABLE ${n.table.name}`
      if (n.type === "alter_table") {
        const drops = n.actions
          .filter((a) => a.kind === "drop_column")
          .map((a) => `${n.table.name}.${(a as { kind: "drop_column"; column: string }).column}`)
        return drops.length ? `DROP COLUMN ${drops.join(", ")}` : `ALTER TABLE ${n.table.name}`
      }
      return n.type
    })
    .join("\n  ")
}

// ── Per-table diff ──

interface TableDiff {
  destructive: DDLNode[]
  additive: DDLNode[]
}

function diffTable(
  name: string,
  before: NormalizedTable,
  after: NormalizedTable,
  columnRenames: Record<string, string> = {},
): TableDiff {
  // Pull out renames that target this table. The keys are
  // "table.col" — entries whose table prefix doesn't match get
  // ignored. After applying, the resolved pair is treated as
  // "existing column" for the structural diff (same name on both
  // sides), so column-attribute changes (NOT NULL, default, etc.)
  // still get ALTER actions even on the same migration that renames.
  const renameActions: AlterTableAction[] = []
  const renamedFrom = new Set<string>()
  const renamedTo = new Map<string, string>() // after-name → before-name
  for (const [key, target] of Object.entries(columnRenames)) {
    const [fromTable, fromCol] = key.split(".", 2)
    if (fromTable !== name || !fromCol) continue
    if (!before.columns[fromCol]) continue // old column doesn't exist
    if (!after.columns[target]) continue // new column doesn't exist
    if (after.columns[fromCol]) continue // ambiguous — skip silently
    renameActions.push({ kind: "rename_column", from: fromCol, to: target })
    renamedFrom.add(fromCol)
    renamedTo.set(target, fromCol)
  }

  const beforeCols = new Set(Object.keys(before.columns))
  const afterCols = new Set(Object.keys(after.columns))

  const added = [...afterCols].filter((c) => !beforeCols.has(c) && !renamedTo.has(c))
  const removed = [...beforeCols].filter((c) => !afterCols.has(c) && !renamedFrom.has(c))
  const shared = [...afterCols].filter((c) => beforeCols.has(c) && !renamedTo.has(c))

  const destructiveActions: AlterTableAction[] = removed.map((c) => ({
    kind: "drop_column",
    column: c,
  }))

  const additiveActions: AlterTableAction[] = [...renameActions]
  for (const c of added) {
    additiveActions.push({
      kind: "add_column",
      column: columnDefinitionFromBuilder(c, after.columns[c]!),
    })
  }
  // Shared columns (no rename involved): straight attribute diff.
  for (const c of shared) {
    additiveActions.push(
      ...alterActionsForColumn(c, before.columns[c]!._def, after.columns[c]!._def),
    )
  }
  // Renamed columns: attribute diff uses the before-column's def
  // and the after-column's def under the new name. Emit ALTER
  // actions with the new column name (post-rename).
  for (const [newName, oldName] of renamedTo) {
    additiveActions.push(
      ...alterActionsForColumn(
        newName,
        before.columns[oldName]!._def,
        after.columns[newName]!._def,
      ),
    )
  }

  // Table-level constraints: compare by canonical signature. Anything
  // in `before` but not in `after` is dropped; anything in `after` but
  // not in `before` is added. Mutations surface as drop+add of the
  // same-named constraint; unnamed constraints are matched purely by
  // their body (see `signConstraint`). Splitting additions vs. drops
  // keeps them on either side of the destructive gate.
  const { dropped, addedConstraints } = diffConstraints(before.constraints, after.constraints)
  for (const c of dropped) {
    if (c.name === undefined) {
      // An unnamed constraint's drop is "best effort" — most dialects
      // need a name. We emit a placeholder so planners / tests can see
      // the intent and either supply a name via DiffOptions (future) or
      // reject it. Today we simply skip: dropping an unnamed-in-schema
      // constraint is not supported and would require introspection.
      continue
    }
    destructiveActions.push({ kind: "drop_constraint", name: c.name })
  }
  for (const c of addedConstraints) {
    additiveActions.push({ kind: "add_constraint", constraint: c })
  }

  // Index delta. Key indexes by name (they're required-named). Bodies
  // are compared via canonical signature, so a column-set or `unique`
  // flag change surfaces as DROP + CREATE of the same name.
  const indexDelta = diffIndexes(name, before.indexes, after.indexes)

  const result: TableDiff = { destructive: [], additive: [] }
  if (destructiveActions.length > 0) {
    result.destructive.push({
      type: "alter_table",
      table: tableRef(name),
      actions: destructiveActions,
    } satisfies AlterTableNode)
  }
  for (const n of indexDelta.dropped) result.destructive.push(n)
  if (additiveActions.length > 0) {
    result.additive.push({
      type: "alter_table",
      table: tableRef(name),
      actions: additiveActions,
    } satisfies AlterTableNode)
  }
  for (const n of indexDelta.added) result.additive.push(n)
  return result
}

// ── Index diff / materialization ──────────────────────────────────────

function diffIndexes(
  table: string,
  before: readonly IndexDef[] | undefined,
  after: readonly IndexDef[] | undefined,
): { dropped: DropIndexNode[]; added: CreateIndexNode[] } {
  const beforeMap = new Map<string, IndexDef>()
  for (const idx of before ?? []) beforeMap.set(idx.name, idx)
  const afterMap = new Map<string, IndexDef>()
  for (const idx of after ?? []) afterMap.set(idx.name, idx)

  const dropped: DropIndexNode[] = []
  const added: CreateIndexNode[] = []

  for (const [name, idx] of beforeMap) {
    const matched = afterMap.get(name)
    if (!matched) {
      dropped.push({ type: "drop_index", name, table, ifExists: true })
      continue
    }
    if (signIndex(idx) !== signIndex(matched)) {
      dropped.push({ type: "drop_index", name, table, ifExists: true })
      added.push(createIndexFromDef(table, matched))
    }
  }
  for (const [name, idx] of afterMap) {
    if (!beforeMap.has(name)) {
      added.push(createIndexFromDef(table, idx))
    }
  }
  return { dropped, added }
}

/**
 * Canonical signature for an {@link IndexDef}. Drives "did this index
 * change" detection in the diff. The signature captures everything the
 * DDL printer would observe: columns (with directions), unique flag,
 * index method, and partial predicate body.
 */
function signIndex(idx: IndexDef): string {
  const cols = idx.columns
    .map((c) => {
      if (typeof c === "string") return c
      return c.direction === undefined ? c.column : `${c.column} ${c.direction}`
    })
    .join(",")
  const unique = idx.unique ? "u" : ""
  const using = idx.using ?? ""
  const where =
    idx.where === undefined
      ? ""
      : typeof idx.where === "string"
        ? `w:${idx.where}`
        : `w:${JSON.stringify((idx.where as unknown as { node: ExpressionNode }).node)}`
  return `${cols}|${unique}|${using}|${where}`
}

function createIndexFromDef(table: string, idx: IndexDef): CreateIndexNode {
  const columns = idx.columns.map<{ column: string; direction?: "ASC" | "DESC" }>((c) => {
    if (typeof c === "string") return { column: c }
    return c.direction === undefined
      ? { column: c.column }
      : { column: c.column, direction: c.direction }
  })
  const node: CreateIndexNode = {
    type: "create_index",
    name: idx.name,
    table,
    columns,
  }
  if (idx.unique) node.unique = true
  if (idx.using !== undefined) node.using = idx.using
  if (idx.where !== undefined) {
    const resolved = resolveCheckExpression(idx.where)
    node.where = resolved.node ?? { type: "raw", sql: resolved.sql, params: [] }
  }
  return node
}

function alterActionsForColumn(
  name: string,
  before: ColumnDef,
  after: ColumnDef,
): AlterTableAction[] {
  const actions: AlterTableAction[] = []
  if (before.dataType !== after.dataType) {
    actions.push({
      kind: "alter_column",
      column: name,
      set: { type: "set_data_type", dataType: after.dataType },
    })
  }
  if (before.isNotNull !== after.isNotNull) {
    actions.push({
      kind: "alter_column",
      column: name,
      set: after.isNotNull ? { type: "set_not_null" } : { type: "drop_not_null" },
    })
  }
  // `defaultTo` is captured as `hasDefault + defaultValue`; we treat a
  // change in either as a "set default" unless the new side dropped it.
  if (before.hasDefault && !after.hasDefault) {
    actions.push({ kind: "alter_column", column: name, set: { type: "drop_default" } })
  } else if (after.hasDefault && !before.hasDefault) {
    // The default's AST form lives on the column def when we render it.
    // For diff we can't reconstruct the expression here without the
    // builder's original input. Leave the default unchanged at diff
    // time — users who need to add defaults in an ALTER should do so
    // via a manual migration step. (A TODO for a follow-up.)
  }
  return actions
}

// ── Column builder → AST ──

function columnDefinitionFromBuilder(
  name: string,
  builder: ColumnBuilder<any, any, any>,
): ColumnDefinitionNode {
  const def = builder._def
  const node: ColumnDefinitionNode = {
    type: "column_definition",
    name,
    dataType: def.dataType,
  }
  if (def.isNotNull) node.notNull = true
  if (def.isPrimaryKey) node.primaryKey = true
  if (def.isUnique) node.unique = true
  if (def.references) node.references = { ...def.references }
  if (def.check) {
    // Prefer a pre-built Expression node if the caller used `sql\`...\``;
    // fall back to raw SQL (authored, not user-supplied) when the builder
    // was called with a string.
    node.check = def.check.node ?? {
      type: "raw",
      sql: def.check.sql,
      params: def.check.params ? [...def.check.params] : [],
    }
  }
  // Default value: prefer the expression form when both are set (the
  // builder writes one OR the other, so "both set" doesn't actually
  // happen — the check is defensive). Literals go through `literal`
  // nodes so the printer quotes / escapes them the same way it does
  // for value expressions elsewhere; `LiteralNode.value` is narrow
  // (string | number | boolean | null) so anything else falls
  // through to a parameterised expression default.
  if (def.defaultExpression !== undefined) {
    node.defaultTo = def.defaultExpression
  } else if (def.hasDefault && def.defaultValue !== undefined) {
    const v = def.defaultValue
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      node.defaultTo = { type: "literal", value: v }
    }
    // Other value shapes (Date, objects) aren't currently supported
    // as column defaults — callers with those needs should pass an
    // expression via `.defaultTo(sql`...`)`.
  }
  // Generated column: carry the expression node + stored flag through.
  if (def.generated) {
    node.generatedAs =
      def.generated.stored === undefined
        ? { expression: def.generated.expression }
        : { expression: def.generated.expression, stored: def.generated.stored }
  }
  return node
}

function createTableFromSchema(name: string, table: NormalizedTable): CreateTableNode {
  return {
    type: "create_table",
    table: tableRef(name),
    columns: Object.entries(table.columns).map(([colName, builder]) =>
      columnDefinitionFromBuilder(colName, builder),
    ),
    constraints: materializeConstraints(table.constraints),
  }
}

// ── Constraint materialization & diff ─────────────────────────────────

/**
 * Lower a public {@link TableConstraints} value into the array of AST
 * constraint nodes that `CreateTableNode.constraints` and
 * `AlterTableAction.add_constraint` speak. Kept as a pure function so
 * both the "create a fresh table" and "alter a shared table" paths
 * share one rendering.
 */
function materializeConstraints(constraints: TableConstraints | undefined): TableConstraintNode[] {
  if (!constraints) return []
  const out: TableConstraintNode[] = []
  if (constraints.primaryKey !== undefined) {
    out.push(materializePrimaryKey(constraints.primaryKey))
  }
  for (const u of constraints.uniques ?? []) out.push(materializeUnique(u))
  for (const c of constraints.checks ?? []) out.push(materializeCheck(c))
  for (const fk of constraints.foreignKeys ?? []) out.push(materializeForeignKey(fk))
  return out
}

function materializePrimaryKey(def: PrimaryKeyDef): TableConstraintNode {
  const { name, columns } = normalizeKeyDef(def)
  return name === undefined
    ? { type: "pk_constraint", columns }
    : { type: "pk_constraint", name, columns }
}

function materializeUnique(def: UniqueDef): TableConstraintNode {
  const { name, columns } = normalizeKeyDef(def)
  return name === undefined
    ? { type: "unique_constraint", columns }
    : { type: "unique_constraint", name, columns }
}

function materializeCheck(def: CheckDef): TableConstraintNode {
  const resolved = resolveCheckExpression(def.expression)
  const expression = resolved.node ?? ({ type: "raw", sql: resolved.sql, params: [] } as const)
  return def.name === undefined
    ? { type: "check_constraint", expression }
    : { type: "check_constraint", name: def.name, expression }
}

function materializeForeignKey(def: ForeignKeyDef): TableConstraintNode {
  const references = {
    table: def.references.table,
    columns: [...def.references.columns],
    onDelete: def.onDelete,
    onUpdate: def.onUpdate,
  }
  const base = { type: "fk_constraint" as const, columns: [...def.columns], references }
  return def.name === undefined ? base : { ...base, name: def.name }
}

/**
 * Deep-compare two constraint sets and split the delta into "to drop"
 * and "to add". We key each constraint by a canonical signature; any
 * rename, column-set edit, or CHECK body change manifests as
 * drop-by-name + add-with-new-signature.
 */
function diffConstraints(
  before: TableConstraints | undefined,
  after: TableConstraints | undefined,
): { dropped: TableConstraintNode[]; addedConstraints: TableConstraintNode[] } {
  const beforeNodes = materializeConstraints(before)
  const afterNodes = materializeConstraints(after)
  const beforeMap = new Map(beforeNodes.map((n) => [signConstraint(n), n]))
  const afterMap = new Map(afterNodes.map((n) => [signConstraint(n), n]))

  const dropped: TableConstraintNode[] = []
  const addedConstraints: TableConstraintNode[] = []
  for (const [sig, node] of beforeMap) {
    if (!afterMap.has(sig)) dropped.push(node)
  }
  for (const [sig, node] of afterMap) {
    if (!beforeMap.has(sig)) addedConstraints.push(node)
  }
  return { dropped, addedConstraints }
}

/**
 * Canonical signature used to match constraints across before/after.
 * Named constraints key on the name; unnamed ones key on their body so
 * a noop repeat is not double-counted. CHECK bodies are compared via
 * `JSON.stringify` on the expression node — good enough for diff.
 */
function signConstraint(node: TableConstraintNode): string {
  if (node.name) return `${node.type}:${node.name}`
  switch (node.type) {
    case "pk_constraint":
      return `pk:${node.columns.join(",")}`
    case "unique_constraint":
      return `unique:${node.columns.join(",")}`
    case "check_constraint":
      return `check:${JSON.stringify(node.expression)}`
    case "fk_constraint":
      return `fk:${node.columns.join(",")}->${node.references.table}(${node.references.columns.join(",")})`
  }
}

// ── Input normalization ────────────────────────────────────────────────

/**
 * Lower a {@link SchemaDef} to the internal `{ [table]: NormalizedTable }`
 * shape. Accepts legacy column maps, `defineTable(...)` wrappers, and
 * pre-normalized entries interchangeably.
 */
function normalizeSchema(schema: SchemaDef): Record<string, NormalizedTable> {
  const out: Record<string, NormalizedTable> = {}
  for (const [name, entry] of Object.entries(schema)) {
    if (isTableDefinition(entry)) {
      out[name] = buildNormalized(entry.columns, entry.constraints, entry.indexes)
      continue
    }
    if (isNormalizedTable(entry)) {
      out[name] = buildNormalized(entry.columns, entry.constraints, entry.indexes)
      continue
    }
    out[name] = { columns: entry }
  }
  return out
}

function buildNormalized(
  columns: Record<string, ColumnBuilder<any, any, any>>,
  constraints: TableConstraints | undefined,
  indexes: readonly IndexDef[] | undefined,
): NormalizedTable {
  const out: NormalizedTable = { columns }
  if (constraints) (out as { constraints?: TableConstraints }).constraints = constraints
  if (indexes) (out as { indexes?: readonly IndexDef[] }).indexes = indexes
  return out
}

function isNormalizedTable(entry: unknown): entry is NormalizedTable {
  if (entry === null || typeof entry !== "object") return false
  const obj = entry as Record<string, unknown>
  if (!("columns" in obj) || typeof obj["columns"] !== "object" || obj["columns"] === null) {
    return false
  }
  // A ColumnBuilder also has a "columns" key? No — a ColumnBuilder has
  // `_def`. The legacy shape is a Record<string, ColumnBuilder>; it
  // would not have a top-level `columns` field unless the user happened
  // to name a column "columns", which is a string → ColumnBuilder, not
  // an object-of-columns. The nested object here is always a columns
  // map.
  for (const v of Object.values(obj["columns"] as Record<string, unknown>)) {
    return v !== null && typeof v === "object" && "_def" in (v as object)
  }
  return true
}

// ── Topological sort ──

/**
 * Order new tables so a table that FK-references another new table
 * comes after it. Cycles are broken arbitrarily (and flagged in
 * practice via SQL errors on the driver side — FK cycles almost always
 * mean the schema is wrong).
 */
function topoSortForCreation(tables: string[], schema: Record<string, NormalizedTable>): string[] {
  const deps = new Map<string, Set<string>>()
  for (const t of tables) {
    const needs = new Set<string>()
    const entry = schema[t]!
    for (const col of Object.values(entry.columns)) {
      const ref = col._def.references?.table
      if (ref && tables.includes(ref) && ref !== t) needs.add(ref)
    }
    for (const fk of entry.constraints?.foreignKeys ?? []) {
      const ref = fk.references.table
      if (tables.includes(ref) && ref !== t) needs.add(ref)
    }
    deps.set(t, needs)
  }

  const ordered: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function visit(t: string): void {
    if (visited.has(t)) return
    if (visiting.has(t)) {
      // Cycle — fall through; SQL engine will surface it.
      return
    }
    visiting.add(t)
    for (const dep of deps.get(t) ?? []) visit(dep)
    visiting.delete(t)
    visited.add(t)
    ordered.push(t)
  }

  for (const t of tables) visit(t)
  return ordered
}
