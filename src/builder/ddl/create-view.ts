import type { CreateViewNode, RefreshMaterializedViewNode } from "../../ast/ddl-nodes.ts"
import type { SelectNode } from "../../ast/nodes.ts"

/**
 * Immutable builder for {@link CreateViewNode}. Every mutator returns a
 * fresh builder so the same factory call can be reused as a template.
 *
 * Quick reference:
 *
 * - `.orReplace()` — PG / MySQL emit `CREATE OR REPLACE VIEW`. SQLite
 *   has no equivalent and the printer refuses (use `DROP VIEW IF
 *   EXISTS` + `CREATE VIEW`). MSSQL also rejects — use `.orAlter()`
 *   for the MSSQL-specific `CREATE OR ALTER VIEW` form.
 * - `.orAlter()` — MSSQL-only `CREATE OR ALTER VIEW` (2016 SP1+).
 *   Semantically equivalent to `OR REPLACE` on PG/MySQL but spelled
 *   differently; the two methods are mutually exclusive.
 * - `.ifNotExists()` — PG / MySQL / SQLite emit `IF NOT EXISTS`; MSSQL
 *   has no form and the printer refuses (wrap in
 *   `IF NOT EXISTS(SELECT * FROM sys.views WHERE name = '…') BEGIN …
 *   END`).
 * - `.materialized()` — PG only. Other dialects refuse.
 * - `.withData(bool)` — PG MATERIALIZED VIEW only. `false` emits
 *   `WITH NO DATA`. Default behavior (when never set) is `WITH DATA`.
 * - `.temporary()` — PG / MySQL / SQLite session-scoped view.
 * - `.columns(...)` — explicit column rename list.
 * - `.asSelect(query)` — required. Builders without this set fail at
 *   print time.
 */
export class CreateViewBuilder {
  private readonly node: CreateViewNode

  constructor(name: string, schema?: string)
  constructor(node: CreateViewNode)
  constructor(nameOrNode: string | CreateViewNode, schema?: string) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "create_view",
        name: nameOrNode,
        schema,
      }
    } else {
      this.node = nameOrNode
    }
  }

  orReplace(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, orReplace: true })
  }

  /**
   * MSSQL-only `CREATE OR ALTER VIEW` (2016 SP1+). Use this on MSSQL
   * where PG / MySQL would call `.orReplace()`. The printer refuses on
   * non-MSSQL dialects; the two methods are mutually exclusive.
   */
  orAlter(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, orAlter: true })
  }

  temporary(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, temporary: true })
  }

  materialized(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, materialized: true })
  }

  /**
   * PG MATERIALIZED VIEW only. Pass `false` to emit `WITH NO DATA`,
   * which creates the view's catalog entry but leaves storage empty;
   * the view is unqueryable until the first `REFRESH MATERIALIZED VIEW`.
   * Pass `true` (or omit entirely) to populate the view at creation.
   * Ignored on non-materialized views and non-PG dialects.
   */
  withData(value = true): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, withData: value })
  }

  ifNotExists(): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, ifNotExists: true })
  }

  columns(...cols: string[]): CreateViewBuilder {
    return new CreateViewBuilder({
      ...this.node,
      columns: [...(this.node.columns ?? []), ...cols],
    })
  }

  asSelect(query: SelectNode): CreateViewBuilder {
    return new CreateViewBuilder({ ...this.node, asSelect: query })
  }

  build(): CreateViewNode {
    return { ...this.node }
  }
}

export function createView(name: string, schema?: string): CreateViewBuilder {
  return new CreateViewBuilder(name, schema)
}

/**
 * Immutable builder for {@link RefreshMaterializedViewNode}.
 *
 * - `.concurrently()` — PG only. Requires a UNIQUE index on the view's
 *   projected rows. Refresh runs in a swap-on-finish strategy that
 *   keeps the old data readable for the full duration of the refresh.
 *   Without it, the view is locked exclusively while the refresh runs
 *   (no reads, no writes).
 * - `.withData(false)` — emit `WITH NO DATA`, leaving the view empty
 *   after the refresh. Useful when paired with a later concurrent
 *   refresh on a low-traffic window.
 */
export class RefreshMaterializedViewBuilder {
  private readonly node: RefreshMaterializedViewNode

  constructor(name: string, schema?: string)
  constructor(node: RefreshMaterializedViewNode)
  constructor(nameOrNode: string | RefreshMaterializedViewNode, schema?: string) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "refresh_materialized_view",
        name: nameOrNode,
        schema,
      }
    } else {
      this.node = nameOrNode
    }
  }

  concurrently(): RefreshMaterializedViewBuilder {
    return new RefreshMaterializedViewBuilder({ ...this.node, concurrently: true })
  }

  withData(value = true): RefreshMaterializedViewBuilder {
    return new RefreshMaterializedViewBuilder({ ...this.node, withData: value })
  }

  build(): RefreshMaterializedViewNode {
    return { ...this.node }
  }
}

export function refreshMaterializedView(
  name: string,
  schema?: string,
): RefreshMaterializedViewBuilder {
  return new RefreshMaterializedViewBuilder(name, schema)
}
