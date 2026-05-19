import type { AlterPolicyNode, CreatePolicyNode, DropPolicyNode } from "../../ast/ddl-nodes.ts"
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

/**
 * Immutable builder for {@link AlterPolicyNode} — PostgreSQL
 * `ALTER POLICY <name> ON <table>` in either of its two forms:
 *
 *  - Rename — `ALTER POLICY <name> ON <table> RENAME TO <new>`.
 *  - Modify — `ALTER POLICY <name> ON <table>
 *    [ TO role[, ...] ] [ USING (<expr>) ] [ WITH CHECK (<expr>) ]`.
 *
 * The two forms are mutually exclusive — chaining `.renameTo(...)`
 * after any of `.to(...)` / `.using(...)` / `.withCheck(...)` (or vice
 * versa) is a builder-side mistake. The printer enforces this at print
 * time so a hand-rolled AST can't slip past either. PG itself also
 * accepts the bare `ALTER POLICY <name> ON <table>` with no clauses,
 * but that's a no-op the printer refuses to emit (caller should set at
 * least one slot before `.build()`-ing into a compile).
 *
 * Note: the policy *kind* (permissive vs restrictive) and the *command*
 * (FOR ALL / SELECT / …) are immutable in PG — to change those you
 * have to DROP + CREATE the policy. The builder deliberately offers no
 * `.permissive()` / `.restrictive()` / `.for(...)` methods here.
 *
 * ```ts
 * alterPolicy("tenant_isolation")
 *   .on("orders")
 *   .using(sql`tenant_id = current_setting('app.tenant_id')::int`)
 *   .build()
 * // ALTER POLICY "tenant_isolation" ON "orders"
 * //   USING (tenant_id = current_setting('app.tenant_id')::int)
 *
 * alterPolicy("tenant_isolation").on("orders").renameTo("tenant_iso").build()
 * // ALTER POLICY "tenant_isolation" ON "orders" RENAME TO "tenant_iso"
 * ```
 *
 * Refused on MySQL / SQLite / MSSQL at print time via the
 * `ROW_LEVEL_SECURITY` feature gate.
 */
export class AlterPolicyBuilder {
  private readonly node: AlterPolicyNode

  constructor(name: string)
  constructor(node: AlterPolicyNode)
  constructor(nameOrNode: string | AlterPolicyNode) {
    if (typeof nameOrNode === "string") {
      this.node = {
        type: "alter_policy",
        name: nameOrNode,
        // `table` is required at print time; left empty until `.on()` runs.
        table: "",
      }
    } else {
      this.node = nameOrNode
    }
  }

  private clone(patch: Partial<AlterPolicyNode>): AlterPolicyBuilder {
    return new AlterPolicyBuilder({ ...this.node, ...patch })
  }

  on(table: string, schema?: string): AlterPolicyBuilder {
    return this.clone(schema === undefined ? { table } : { table, schema })
  }

  /**
   * Rename form — `RENAME TO <new>`. Mutually exclusive with the
   * modify-form chains; the printer refuses if both are set.
   */
  renameTo(newName: string): AlterPolicyBuilder {
    return this.clone({ renameTo: newName })
  }

  /**
   * Modify form — replace the applied-roles list with `TO role[, ...]`.
   * Calling `.to(...)` more than once *replaces* the previous list so
   * the chain is idempotent. Mutually exclusive with {@link renameTo}.
   */
  to(...roles: string[]): AlterPolicyBuilder {
    return this.clone({ roles: [...roles] })
  }

  /**
   * Modify form — replace the policy's `USING (<expr>)` predicate.
   * Mutually exclusive with {@link renameTo}.
   */
  using(expr: ExpressionNode | Expression<boolean>): AlterPolicyBuilder {
    return this.clone({ using: unwrapPredicate(expr) })
  }

  /**
   * Modify form — replace the policy's `WITH CHECK (<expr>)`
   * predicate. Mutually exclusive with {@link renameTo}.
   */
  withCheck(expr: ExpressionNode | Expression<boolean>): AlterPolicyBuilder {
    return this.clone({ withCheck: unwrapPredicate(expr) })
  }

  build(): AlterPolicyNode {
    return {
      ...this.node,
      roles: this.node.roles ? [...this.node.roles] : undefined,
    }
  }
}

/**
 * Factory for {@link AlterPolicyBuilder}.
 */
export function alterPolicy(name: string): AlterPolicyBuilder {
  return new AlterPolicyBuilder(name)
}
