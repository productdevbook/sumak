import type { CreateTriggerNode, DropTriggerNode } from "../../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../../ast/nodes.ts"
import type { Expression } from "../../ast/typed-expression.ts"

type TriggerEvent = "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE"

/**
 * Builder for {@link CreateTriggerNode} — PostgreSQL `CREATE TRIGGER`
 * standalone DDL referencing a separately-declared function by name.
 *
 * Full grammar surface in Phase 1 (ADR 005):
 *
 *  - Timing: `.before(...)`, `.after(...)`, `.insteadOf(...)`.
 *  - Events: passed positionally to the timing call; multi-event
 *    triggers fire on any of the listed events. The `UPDATE` event
 *    optionally takes a column list — that becomes
 *    `UPDATE OF "col1", "col2"`.
 *  - Granularity: `.forEachRow()` / `.forEachStatement()` (default ROW
 *    when neither is set, matching PG's default for row triggers).
 *  - `.when(expr | sql\`\`)` — boolean predicate. Phase 1 takes any
 *    `Expression<boolean>`; for `NEW.<col>` / `OLD.<col>` references
 *    use a `sql\`\`` template until Phase 2's typed proxy lands.
 *  - `.executeFunction(name, ...args?)` — the function to fire. Args
 *    are passed verbatim through the DDL expression printer (most
 *    triggers take no args; the few that do typically pass literals).
 *  - `.deferrable({ initiallyDeferred? })` — emit `CREATE CONSTRAINT
 *    TRIGGER ... DEFERRABLE [INITIALLY DEFERRED]`. Constraint triggers
 *    fire at commit time rather than statement time.
 *
 * ```ts
 * pg.schema.createTrigger("audit_users_updated")
 *   .on("users")
 *   .after("UPDATE", "email", "phone")
 *   .forEachRow()
 *   .when(sql\`NEW."email" IS DISTINCT FROM OLD."email"\`)
 *   .executeFunction("log_user_change")
 *   .build()
 * ```
 *
 * PostgreSQL only — the DDL printer refuses on MySQL / SQLite / MSSQL
 * via the `CREATE_TRIGGER` feature gate.
 */
export class CreateTriggerBuilder {
  private readonly node: CreateTriggerNode

  constructor(name: string)
  constructor(node: CreateTriggerNode)
  constructor(arg1: string | CreateTriggerNode) {
    if (typeof arg1 === "string") {
      this.node = {
        type: "create_trigger",
        name: arg1,
        table: "",
        timing: "AFTER",
        events: [],
        forEach: "ROW",
        functionName: "",
      }
    } else {
      this.node = arg1
    }
  }

  private clone(patch: Partial<CreateTriggerNode>): CreateTriggerBuilder {
    return new CreateTriggerBuilder({ ...this.node, ...patch })
  }

  /** `CREATE OR REPLACE TRIGGER` — PG 14+. */
  orReplace(): CreateTriggerBuilder {
    return this.clone({ orReplace: true })
  }

  on(table: string, schema?: string): CreateTriggerBuilder {
    return this.clone(schema === undefined ? { table } : { table, schema })
  }

  /** `BEFORE <event>[, <event>...]` — multi-event triggers fire on any
   * of the listed events. The `UPDATE` event accepts optional column
   * names — pass them as `.before("UPDATE", "col1", "col2")` to emit
   * `BEFORE UPDATE OF "col1", "col2"`. */
  before(event: TriggerEvent, ...updateOfCols: string[]): CreateTriggerBuilder {
    return this.events("BEFORE", [event], updateOfCols)
  }

  after(event: TriggerEvent, ...updateOfCols: string[]): CreateTriggerBuilder {
    return this.events("AFTER", [event], updateOfCols)
  }

  insteadOf(event: TriggerEvent, ...updateOfCols: string[]): CreateTriggerBuilder {
    return this.events("INSTEAD OF", [event], updateOfCols)
  }

  /**
   * Lower-level events setter — useful when you want multiple events
   * in one call (`AFTER INSERT OR UPDATE OR DELETE`). The timing must
   * already be set via `.before(...)` / `.after(...)` / `.insteadOf(...)`
   * — calling `.events(...)` after one of those *replaces* the prior
   * event list with the new one while preserving the timing.
   *
   * Pass `updateOf` to restrict an `UPDATE` event to specific columns
   * — only valid when the event list contains `UPDATE`.
   */
  withEvents(events: TriggerEvent[], opts: { updateOf?: string[] } = {}): CreateTriggerBuilder {
    if (events.length === 0) {
      throw new Error(
        `CREATE TRIGGER "${this.node.name}": .withEvents([]) requires at least one event.`,
      )
    }
    return this.clone({
      events: [...events],
      updateOf: opts.updateOf ? [...opts.updateOf] : undefined,
    })
  }

  private events(
    timing: CreateTriggerNode["timing"],
    events: TriggerEvent[],
    updateOfCols: string[],
  ): CreateTriggerBuilder {
    const updateOf = updateOfCols.length > 0 ? [...updateOfCols] : undefined
    if (updateOf && !events.includes("UPDATE")) {
      throw new Error(
        `CREATE TRIGGER "${this.node.name}": UPDATE OF column list is only valid with the UPDATE event.`,
      )
    }
    return this.clone({ timing, events: [...events], updateOf })
  }

  forEachRow(): CreateTriggerBuilder {
    return this.clone({ forEach: "ROW" })
  }

  forEachStatement(): CreateTriggerBuilder {
    return this.clone({ forEach: "STATEMENT" })
  }

  when(expr: ExpressionNode | Expression<boolean>): CreateTriggerBuilder {
    const node = unwrapPredicate(expr)
    return this.clone({ when: node })
  }

  /**
   * `EXECUTE FUNCTION "name"(args)` — the function to fire. Most
   * triggers take no args; pass them positionally if needed (literals,
   * `val(...)`, etc.). Schema-qualified function names should be
   * passed as a two-arg form: `.executeFunction({ schema, name }, ...)`.
   */
  executeFunction(
    name: string | { name: string; schema?: string },
    ...args: (ExpressionNode | Expression<unknown> | string | number | boolean | null)[]
  ): CreateTriggerBuilder {
    const fnName = typeof name === "string" ? name : name.name
    const fnSchema = typeof name === "string" ? undefined : name.schema
    const argNodes = args.length > 0 ? args.map((a) => coerceArg(a)) : undefined
    return this.clone({
      functionName: fnName,
      functionSchema: fnSchema,
      functionArgs: argNodes,
    })
  }

  /**
   * `CREATE CONSTRAINT TRIGGER ... DEFERRABLE [INITIALLY DEFERRED]`.
   * Constraint triggers fire at commit time rather than statement
   * time; they must use `AFTER` timing and `FOR EACH ROW`.
   */
  deferrable(opts: { initiallyDeferred?: boolean } = {}): CreateTriggerBuilder {
    return this.clone({
      constraint: { deferrable: true, initiallyDeferred: opts.initiallyDeferred === true },
    })
  }

  build(): CreateTriggerNode {
    return {
      ...this.node,
      events: [...this.node.events],
      updateOf: this.node.updateOf ? [...this.node.updateOf] : undefined,
      functionArgs: this.node.functionArgs ? [...this.node.functionArgs] : undefined,
      constraint: this.node.constraint ? { ...this.node.constraint } : undefined,
    }
  }
}

function unwrapPredicate(expr: ExpressionNode | Expression<boolean>): ExpressionNode {
  if (
    typeof expr === "object" &&
    expr !== null &&
    "node" in (expr as { node?: unknown }) &&
    typeof (expr as { node?: unknown }).node === "object" &&
    (expr as { node: unknown }).node !== null
  ) {
    return (expr as Expression<boolean>).node
  }
  return expr as ExpressionNode
}

function coerceArg(
  v: ExpressionNode | Expression<unknown> | string | number | boolean | null,
): ExpressionNode {
  if (
    typeof v === "object" &&
    v !== null &&
    "node" in (v as { node?: unknown }) &&
    typeof (v as { node?: unknown }).node === "object" &&
    (v as { node: unknown }).node !== null
  ) {
    return (v as Expression<unknown>).node
  }
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return { type: "literal", value: v }
  }
  return v as ExpressionNode
}

/** Factory for {@link CreateTriggerBuilder}. */
export function createTrigger(name: string): CreateTriggerBuilder {
  return new CreateTriggerBuilder(name)
}

/**
 * Builder for {@link DropTriggerNode} — PostgreSQL
 * `DROP TRIGGER [IF EXISTS] <name> ON <table> [CASCADE]`.
 */
export class DropTriggerBuilder {
  private readonly node: DropTriggerNode

  constructor(name: string)
  constructor(node: DropTriggerNode)
  constructor(arg1: string | DropTriggerNode) {
    if (typeof arg1 === "string") {
      this.node = { type: "drop_trigger", name: arg1, table: "" }
    } else {
      this.node = arg1
    }
  }

  private clone(patch: Partial<DropTriggerNode>): DropTriggerBuilder {
    return new DropTriggerBuilder({ ...this.node, ...patch })
  }

  on(table: string, schema?: string): DropTriggerBuilder {
    return this.clone(schema === undefined ? { table } : { table, schema })
  }

  ifExists(): DropTriggerBuilder {
    return this.clone({ ifExists: true })
  }

  cascade(): DropTriggerBuilder {
    return this.clone({ cascade: true })
  }

  build(): DropTriggerNode {
    return { ...this.node }
  }
}

/** Factory for {@link DropTriggerBuilder}. */
export function dropTrigger(name: string): DropTriggerBuilder {
  return new DropTriggerBuilder(name)
}
