import type { AlterSequenceNode } from "../../ast/ddl-nodes.ts"

/**
 * Immutable builder for {@link AlterSequenceNode}. Every mutator returns
 * a fresh builder so the same factory call can be reused as a template.
 *
 * `ALTER SEQUENCE` lets you change a sequence's properties post-creation
 * without dropping and recreating it. The two highest-leverage workflows:
 *
 *  - **Reset the current value**: `.restartWith(1)` (or `.restart()` to
 *    reset to the recorded start) — the next `nextval` returns the
 *    given number.
 *  - **Retune for throughput**: `.cache(50)` to pre-allocate batches
 *    of 50 values per session, or `.increment(10)` to coarsen the
 *    step so multiple workers can claim non-overlapping ranges.
 *
 * Quick reference:
 *
 *  - `.ifExists()` — PG only. MSSQL has no first-class form on
 *    `ALTER SEQUENCE`; the printer refuses there.
 *  - `.dataType(t)` — PG only on this statement. MSSQL has no
 *    grammar for changing the data type after creation.
 *  - `.increment(n)` — step; may be negative to count downwards.
 *  - `.minValue(n)` / `.noMinValue()` / `.maxValue(n)` / `.noMaxValue()`
 *    — bounds.
 *  - `.start(n)` — `START WITH n`. PG only on `ALTER SEQUENCE`; this
 *    changes the *recorded* start (used by future `RESTART` with no
 *    argument) but does not move the current value. To reset the
 *    current value, use `.restart()` / `.restartWith(n)`.
 *  - `.restart()` — bare `RESTART`; resets the current value to the
 *    recorded start.
 *  - `.restartWith(n)` — `RESTART WITH n`; resets the current value to
 *    the given number.
 *  - `.cache(n)` — batch size for pre-allocation.
 *  - `.noCache()` — MSSQL only; PG has no `NO CACHE` keyword on
 *    ALTER. Pass `.cache(1)` (the implicit minimum) on PG instead.
 *  - `.cycle()` / `.noCycle()` — wrap on overflow.
 *  - `.ownedBy(table, col)` / `.ownedByNone()` — PG only; ties the
 *    sequence's lifetime to a column or clears the link.
 */
export class AlterSequenceBuilder {
  private readonly node: AlterSequenceNode

  constructor(name: string, schema?: string)
  constructor(node: AlterSequenceNode)
  constructor(nameOrNode: string | AlterSequenceNode, schema?: string) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "alter_sequence",
        name: nameOrNode,
        schema,
      }
    } else {
      this.node = nameOrNode
    }
  }

  ifExists(): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, ifExists: true })
  }

  dataType(type: string): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, dataType: type })
  }

  increment(by: number): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, increment: by })
  }

  minValue(value: number): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, minValue: value })
  }

  noMinValue(): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, minValue: null })
  }

  maxValue(value: number): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, maxValue: value })
  }

  noMaxValue(): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, maxValue: null })
  }

  start(value: number): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, start: value })
  }

  /**
   * `RESTART` — bare form, resets the current value back to the
   * sequence's recorded start. Use {@link restartWith} when you need a
   * specific reset target.
   */
  restart(): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, restart: true })
  }

  /**
   * `RESTART WITH <n>` — explicit reset target. The next `nextval`
   * returns `n` (PG) / `n` (MSSQL) on the first call after the ALTER.
   */
  restartWith(value: number): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, restart: { value } })
  }

  cache(value: number): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, cache: value })
  }

  /**
   * `NO CACHE` — MSSQL only. PG has no `NO CACHE` keyword on `ALTER
   * SEQUENCE`; the printer refuses on PG and points at `.cache(1)`
   * (the implicit minimum) as the workaround.
   */
  noCache(): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, cache: null })
  }

  cycle(value = true): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, cycle: value })
  }

  noCycle(): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, cycle: false })
  }

  /**
   * `OWNED BY <table>.<column>` — PG only. Ties the sequence's lifetime
   * to the named column. MSSQL has no equivalent; the printer refuses
   * on that dialect.
   */
  ownedBy(table: string, column: string): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, ownedBy: { table, column } })
  }

  /** `OWNED BY NONE` — PG only; clears any existing ownership link. */
  ownedByNone(): AlterSequenceBuilder {
    return new AlterSequenceBuilder({ ...this.node, ownedBy: "NONE" })
  }

  build(): AlterSequenceNode {
    return { ...this.node }
  }
}

export function alterSequence(name: string, schema?: string): AlterSequenceBuilder {
  return new AlterSequenceBuilder(name, schema)
}
