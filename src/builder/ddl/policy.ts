import type { CreatePolicyNode, DropPolicyNode } from "../../ast/ddl-nodes.ts"
import type { ExpressionNode } from "../../ast/nodes.ts"
import type { Expression } from "../../ast/typed-expression.ts"

/**
 * Accept either a typed `Expression<boolean>` wrapper (the runtime
 * shape returned by `eb({...}) => col.eq(...)` and `sql\`...\``) or a
 * raw `ExpressionNode`. Returns the underlying node. Mirrors the
 * `CreateIndexBuilder.where()` lowering pattern so the policy
 * predicates accept the same surface a partial-index predicate does.
 */
function unwrapPredicate(expr: ExpressionNode | Expression<boolean>): ExpressionNode {
  const maybeWrapper = expr as { node?: ExpressionNode }
  return maybeWrapper.node ?? (expr as ExpressionNode)
}

/**
 * Immutable builder for {@link CreatePolicyNode} — PostgreSQL
 * `CREATE POLICY <name> ON <table> [AS PERMISSIVE | RESTRICTIVE]
 * [FOR { ALL | SELECT | INSERT | UPDATE | DELETE }] [TO role[, ...]]
 * [USING (expr)] [WITH CHECK (expr)]`.
 *
 * Quick reference:
 *
 *  - `.on(table)` — required; targets the table whose RLS the policy
 *    attaches to.
 *  - `.permissive()` / `.restrictive()` — pick the policy kind. Default
 *    (neither set) emits no keyword; PG treats that as `PERMISSIVE`.
 *  - `.for("SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL")` — limit
 *    the policy to one DML kind.
 *  - `.to(...roles)` — list of role names. The three reserved
 *    keywords `PUBLIC` / `CURRENT_USER` / `SESSION_USER` are passed
 *    through verbatim; everything else is quoted as an identifier.
 *  - `.using(expr)` — `USING (<expr>)` predicate. Applied to existing
 *    rows on SELECT / UPDATE / DELETE.
 *  - `.withCheck(expr)` — `WITH CHECK (<expr>)` predicate. Applied to
 *    new / updated rows on INSERT / UPDATE.
 *
 * The predicate slots accept either a sumak `Expression<boolean>`
 * wrapper (e.g. `sql\`tenant_id = current_setting('app.tenant_id')::int\``)
 * or a raw `ExpressionNode`.
 *
 * ```ts
 * createPolicy("tenant_isolation")
 *   .on("orders")
 *   .for("ALL")
 *   .using(sql`tenant_id = current_setting('app.tenant_id')::int`)
 *   .withCheck(sql`tenant_id = current_setting('app.tenant_id')::int`)
 *   .build()
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL at print time — those engines
 * either lack the feature entirely or expose it through a different
 * surface.
 */
export class CreatePolicyBuilder {
  private readonly node: CreatePolicyNode

  constructor(name: string)
  constructor(node: CreatePolicyNode)
  constructor(nameOrNode: string | CreatePolicyNode) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "create_policy",
        name: nameOrNode,
        // `table` is required at print time; left empty until `.on()` runs.
        table: "",
      }
    } else {
      this.node = nameOrNode
    }
  }

  private clone(patch: Partial<CreatePolicyNode>): CreatePolicyBuilder {
    return new CreatePolicyBuilder({ ...this.node, ...patch })
  }

  on(table: string, schema?: string): CreatePolicyBuilder {
    return this.clone(schema === undefined ? { table } : { table, schema })
  }

  /**
   * `AS PERMISSIVE` — explicit PG default. Permissive policies are
   * OR'd together when more than one applies to the same row. Mutually
   * exclusive with {@link restrictive}.
   */
  permissive(): CreatePolicyBuilder {
    return this.clone({ permissive: true, restrictive: false })
  }

  /**
   * `AS RESTRICTIVE` — AND-joined with the union of permissive policies
   * on the same target. Useful for "tenant isolation must always
   * apply on top of whatever else we allow". Mutually exclusive with
   * {@link permissive}.
   */
  restrictive(): CreatePolicyBuilder {
    return this.clone({ permissive: false, restrictive: true })
  }

  for(command: NonNullable<CreatePolicyNode["forCommand"]>): CreatePolicyBuilder {
    return this.clone({ forCommand: command })
  }

  /**
   * `TO role_name [, ...]` — list of roles the policy applies to.
   * Calling `.to(...)` more than once *replaces* the previous list so
   * the chain is idempotent.
   */
  to(...roles: string[]): CreatePolicyBuilder {
    return this.clone({ roles: [...roles] })
  }

  using(expr: ExpressionNode | Expression<boolean>): CreatePolicyBuilder {
    return this.clone({ using: unwrapPredicate(expr) })
  }

  withCheck(expr: ExpressionNode | Expression<boolean>): CreatePolicyBuilder {
    return this.clone({ withCheck: unwrapPredicate(expr) })
  }

  build(): CreatePolicyNode {
    return {
      ...this.node,
      roles: this.node.roles ? [...this.node.roles] : undefined,
    }
  }
}

/**
 * Factory for {@link CreatePolicyBuilder}. The `.on(table)` chain is
 * required before `.build()` — the printer rejects an empty table
 * name.
 */
export function createPolicy(name: string): CreatePolicyBuilder {
  return new CreatePolicyBuilder(name)
}

/**
 * Immutable builder for {@link DropPolicyNode} — PostgreSQL
 * `DROP POLICY [IF EXISTS] <name> ON <table> [CASCADE | RESTRICT]`.
 *
 *  - `.on(table)` — required.
 *  - `.ifExists()` — emit `IF EXISTS`.
 *  - `.cascade()` — emit `CASCADE`. PG accepts it though there are no
 *    dependent objects in practice; the keyword survives an
 *    introspection round-trip.
 *
 * Refused on MySQL / SQLite / MSSQL at print time.
 */
export class DropPolicyBuilder {
  private readonly node: DropPolicyNode

  constructor(name: string)
  constructor(node: DropPolicyNode)
  constructor(nameOrNode: string | DropPolicyNode) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "drop_policy",
        name: nameOrNode,
        table: "",
      }
    } else {
      this.node = nameOrNode
    }
  }

  private clone(patch: Partial<DropPolicyNode>): DropPolicyBuilder {
    return new DropPolicyBuilder({ ...this.node, ...patch })
  }

  on(table: string, schema?: string): DropPolicyBuilder {
    return this.clone(schema === undefined ? { table } : { table, schema })
  }

  ifExists(): DropPolicyBuilder {
    return this.clone({ ifExists: true })
  }

  cascade(): DropPolicyBuilder {
    return this.clone({ cascade: true })
  }

  build(): DropPolicyNode {
    return { ...this.node }
  }
}

/**
 * Factory for {@link DropPolicyBuilder}.
 */
export function dropPolicy(name: string): DropPolicyBuilder {
  return new DropPolicyBuilder(name)
}
