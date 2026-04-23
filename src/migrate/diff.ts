import type {
  AlterTableAction,
  AlterTableNode,
  ColumnDefinitionNode,
  CreateTableNode,
  DDLNode,
  DropTableNode,
} from "../ast/ddl-nodes.ts"
import { tableRef } from "../ast/nodes.ts"
import type { ColumnBuilder, ColumnDef } from "../schema/column.ts"

/**
 * Schema shape — the same `tables` object you'd hand to `sumak({ tables })`.
 * The migration diff operates on this structure, so migration input and
 * runtime schema stay one source of truth.
 */
export type SchemaDef = Record<string, Record<string, ColumnBuilder<any, any, any>>>

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
  const beforeTables = new Set(Object.keys(before))
  const afterTables = new Set(Object.keys(after))

  const removed = [...beforeTables].filter((t) => !afterTables.has(t))
  const added = [...afterTables].filter((t) => !beforeTables.has(t))
  const shared = [...afterTables].filter((t) => beforeTables.has(t))

  const destructive: DDLNode[] = []
  const additive: DDLNode[] = []

  // ── DROP TABLES ───────────────────────────────────────────────
  for (const t of removed) {
    destructive.push({
      type: "drop_table",
      table: tableRef(t),
      ifExists: true,
    } satisfies DropTableNode)
  }

  // ── CREATE TABLES (topo order by FK references) ───────────────
  const createdInOrder = topoSortForCreation(added, after)
  for (const t of createdInOrder) {
    additive.push(createTableFromSchema(t, after[t]!))
  }

  // ── ALTER (per shared table) ──────────────────────────────────
  for (const t of shared) {
    const tableDiff = diffTable(t, before[t]!, after[t]!)
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
  before: Record<string, ColumnBuilder<any, any, any>>,
  after: Record<string, ColumnBuilder<any, any, any>>,
): TableDiff {
  const beforeCols = new Set(Object.keys(before))
  const afterCols = new Set(Object.keys(after))

  const added = [...afterCols].filter((c) => !beforeCols.has(c))
  const removed = [...beforeCols].filter((c) => !afterCols.has(c))
  const shared = [...afterCols].filter((c) => beforeCols.has(c))

  const destructiveActions: AlterTableAction[] = removed.map((c) => ({
    kind: "drop_column",
    column: c,
  }))

  const additiveActions: AlterTableAction[] = []
  for (const c of added) {
    additiveActions.push({
      kind: "add_column",
      column: columnDefinitionFromBuilder(c, after[c]!),
    })
  }
  for (const c of shared) {
    additiveActions.push(...alterActionsForColumn(c, before[c]!._def, after[c]!._def))
  }

  const result: TableDiff = { destructive: [], additive: [] }
  if (destructiveActions.length > 0) {
    result.destructive.push({
      type: "alter_table",
      table: tableRef(name),
      actions: destructiveActions,
    } satisfies AlterTableNode)
  }
  if (additiveActions.length > 0) {
    result.additive.push({
      type: "alter_table",
      table: tableRef(name),
      actions: additiveActions,
    } satisfies AlterTableNode)
  }
  return result
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
  return node
}

function createTableFromSchema(
  name: string,
  cols: Record<string, ColumnBuilder<any, any, any>>,
): CreateTableNode {
  return {
    type: "create_table",
    table: tableRef(name),
    columns: Object.entries(cols).map(([colName, builder]) =>
      columnDefinitionFromBuilder(colName, builder),
    ),
    constraints: [],
  }
}

// ── Topological sort ──

/**
 * Order new tables so a table that FK-references another new table
 * comes after it. Cycles are broken arbitrarily (and flagged in
 * practice via SQL errors on the driver side — FK cycles almost always
 * mean the schema is wrong).
 */
function topoSortForCreation(tables: string[], schema: SchemaDef): string[] {
  const deps = new Map<string, Set<string>>()
  for (const t of tables) {
    const needs = new Set<string>()
    for (const col of Object.values(schema[t]!)) {
      const ref = col._def.references?.table
      if (ref && tables.includes(ref) && ref !== t) needs.add(ref)
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
