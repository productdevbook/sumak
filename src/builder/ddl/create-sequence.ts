import type { CreateSequenceNode, DropSequenceNode } from "../../ast/ddl-nodes.ts"

/**
 * Immutable builder for {@link CreateSequenceNode}. Every mutator returns
 * a fresh builder so the same factory call can be reused as a template.
 *
 * Quick reference:
 *
 * - `.ifNotExists()` — PG only on `CREATE SEQUENCE`. MSSQL has no
 *   first-class form (use `IF NOT EXISTS(SELECT * FROM sys.sequences …)`
 *   wrapper); SQLite / MySQL have no sequences at all and the printer
 *   refuses both at the feature-matrix gate.
 * - `.dataType("bigint")` — `AS <type>`. PG and MSSQL both accept
 *   `smallint` / `integer` / `bigint`; PG also accepts the
 *   `bigserial`-style identity types. Defaults to engine default
 *   (PG: bigint; MSSQL: bigint).
 * - `.increment(n)` — step; may be negative to count downwards.
 * - `.minValue(n)` / `.noMinValue()` / `.maxValue(n)` / `.noMaxValue()`
 *   — bounds. Default is engine-defined (PG: minimum / maximum of the
 *   data type for the sign of `increment`).
 * - `.start(n)` — first value handed out.
 * - `.cache(n)` — batch size for pre-allocation. PG and MSSQL both
 *   accept this; setting `0` on MSSQL is the documented way to disable.
 * - `.cycle()` / `.noCycle()` — wrap on overflow.
 * - `.ownedBy(table, column)` — PG only; ties the sequence's lifetime
 *   to the named column. `.ownedByNone()` clears the link.
 */
export class CreateSequenceBuilder {
  private readonly node: CreateSequenceNode

  constructor(name: string, schema?: string)
  constructor(node: CreateSequenceNode)
  constructor(nameOrNode: string | CreateSequenceNode, schema?: string) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "create_sequence",
        name: nameOrNode,
        schema,
      }
    } else {
      this.node = nameOrNode
    }
  }

  ifNotExists(): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, ifNotExists: true })
  }

  dataType(type: string): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, dataType: type })
  }

  increment(by: number): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, increment: by })
  }

  minValue(value: number): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, minValue: value })
  }

  noMinValue(): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, minValue: null })
  }

  maxValue(value: number): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, maxValue: value })
  }

  noMaxValue(): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, maxValue: null })
  }

  start(value: number): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, start: value })
  }

  cache(value: number): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, cache: value })
  }

  cycle(value = true): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, cycle: value })
  }

  noCycle(): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, cycle: false })
  }

  /**
   * `OWNED BY <table>.<column>` — PG only. Ties the sequence's lifetime
   * to the named column: when the column / table is dropped, the
   * sequence is dropped too. MSSQL has no equivalent; the printer
   * refuses on that dialect.
   */
  ownedBy(table: string, column: string): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, ownedBy: { table, column } })
  }

  /**
   * `OWNED BY NONE` — PG only; clears any existing ownership link.
   */
  ownedByNone(): CreateSequenceBuilder {
    return new CreateSequenceBuilder({ ...this.node, ownedBy: "NONE" })
  }

  build(): CreateSequenceNode {
    return { ...this.node }
  }
}

export function createSequence(name: string, schema?: string): CreateSequenceBuilder {
  return new CreateSequenceBuilder(name, schema)
}

/**
 * Immutable builder for {@link DropSequenceNode}.
 *
 * - `.ifExists()` — PG / MSSQL both accept (MSSQL added it in 2016).
 * - `.cascade()` — PG only; MSSQL has no cascade on DROP SEQUENCE
 *   (sequences aren't referentially linked the way tables are).
 */
export class DropSequenceBuilder {
  private readonly node: DropSequenceNode

  constructor(name: string, schema?: string)
  constructor(node: DropSequenceNode)
  constructor(nameOrNode: string | DropSequenceNode, schema?: string) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "drop_sequence",
        name: nameOrNode,
        schema,
      }
    } else {
      this.node = nameOrNode
    }
  }

  ifExists(): DropSequenceBuilder {
    return new DropSequenceBuilder({ ...this.node, ifExists: true })
  }

  cascade(): DropSequenceBuilder {
    return new DropSequenceBuilder({ ...this.node, cascade: true })
  }

  build(): DropSequenceNode {
    return { ...this.node }
  }
}

export function dropSequence(name: string, schema?: string): DropSequenceBuilder {
  return new DropSequenceBuilder(name, schema)
}
