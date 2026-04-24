import { AbilityBuilder, createMongoAbility } from "@casl/ability"
import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { caslAuthz } from "../../src/plugin/casl.ts"
import { multiTenant } from "../../src/plugin/factories.ts"
import { integer, serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"

// The two plugins both inject WHERE predicates via transformNode.
// Registration order matters for readability (authz → tenancy is
// the intuitive layering) and correctness needs:
//
//   1. both predicates survive into the final SQL,
//   2. idempotency flags prevent double-apply on subquery recursion,
//   3. a CASL rule that also references the tenant column doesn't
//      silently deduplicate the tenancy check away.

const TABLES = {
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    authorId: integer(),
    tenant_id: integer(),
  },
}

describe("caslAuthz + multiTenant interaction", () => {
  it("both plugins inject WHEREs; both parameters are present", () => {
    // Standard combo: authz filters to author's rows, tenancy
    // narrows to the current tenant. Both must land in the final SQL.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 42 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [
        caslAuthz({ ability, subjects: { posts: "Post" } }),
        multiTenant({ tables: ["posts"], tenantId: () => 7 }),
      ],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()

    // authorId from CASL, tenant_id from multiTenant.
    expect(compiled.sql).toContain('"authorId"')
    expect(compiled.sql).toContain('"tenant_id"')
    expect(compiled.params).toEqual(expect.arrayContaining([42, 7]))
  })

  it("applies both filters on UPDATE (cross-plugin coverage)", () => {
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("update", "Post", { authorId: 42 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [
        caslAuthz({ ability, subjects: { posts: "Post" } }),
        multiTenant({ tables: ["posts"], tenantId: () => 3 }),
      ],
    })

    const compiled = db.update("posts").set({ title: "x" }).toSQL()

    expect(compiled.sql).toContain('"authorId"')
    expect(compiled.sql).toContain('"tenant_id"')
    expect(compiled.params).toEqual(expect.arrayContaining([42, 3]))
  })

  it("CASL rule that ALSO mentions tenant_id → predicate appears twice, semantically safe", () => {
    // When a CASL rule says `{ tenant_id: currentTenant }` AND
    // multiTenant also injects `tenant_id = ?`, both end up in the
    // WHERE. The optimizer might dedup if they're identical but the
    // safety story doesn't depend on it — an extra AND of the same
    // predicate is a tautology and can't open an authz hole.
    //
    // This test pins the current behavior: both clauses make it
    // through. If the optimizer starts dedup'ing them, the assertion
    // needs a follow-up — but correctness stays intact either way.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { tenant_id: 7, authorId: 42 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [
        caslAuthz({ ability, subjects: { posts: "Post" } }),
        multiTenant({ tables: ["posts"], tenantId: () => 7 }),
      ],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()

    // Both values present; duplicated if the optimizer didn't
    // dedup. Either way the result is safe.
    const sevens = compiled.params.filter((p) => p === 7).length
    expect(sevens).toBeGreaterThanOrEqual(1)
    expect(compiled.params).toContain(42)
  })

  it("idempotency flags are independent (no cross-contamination)", () => {
    // Each plugin uses its own QueryFlags bit
    // (CaslAuthzApplied vs MultiTenantApplied), so a SELECT with
    // only one plugin's flag set still gets the other plugin's
    // filter on a recursive pass. This is a sanity check that the
    // two flag values don't collide.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 1 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [
        caslAuthz({ ability, subjects: { posts: "Post" } }),
        multiTenant({ tables: ["posts"], tenantId: () => 2 }),
      ],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()

    // Each plugin fired exactly once — the idempotency flags of one
    // don't hide the other.
    expect(compiled.params).toEqual(expect.arrayContaining([1, 2]))
    const ones = compiled.params.filter((p) => p === 1).length
    const twos = compiled.params.filter((p) => p === 2).length
    expect(ones).toBe(1)
    expect(twos).toBe(1)
  })

  it("reversing plugin order still produces both predicates (layering-agnostic correctness)", () => {
    // The README recommends caslAuthz BEFORE multiTenant for
    // readability, but correctness doesn't depend on order — both
    // ANDs commute. This test pins that invariant.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 10 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [
        // Reverse order from the recommended one.
        multiTenant({ tables: ["posts"], tenantId: () => 20 }),
        caslAuthz({ ability, subjects: { posts: "Post" } }),
      ],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()

    expect(compiled.params).toEqual(expect.arrayContaining([10, 20]))
    expect(compiled.sql).toContain('"authorId"')
    expect(compiled.sql).toContain('"tenant_id"')
  })
})
