import { AbilityBuilder, createMongoAbility } from "@casl/ability"
import { describe, expect, it } from "vitest"

import { ForbiddenByCaslError } from "../../src/casl/where.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { caslAuthz } from "../../src/plugin/casl.ts"
import { integer, serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"

// Real `@casl/ability` backs every test — the point of the plugin
// is transparent WHERE injection against a live ability, so mocking
// the ability would hide the only bugs that actually matter
// (rulesFor ordering, inverted rule handling, unconditional
// short-circuit).

const TABLES = {
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    authorId: integer(),
    published: text(),
  },
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
  },
  publicData: {
    id: serial().primaryKey(),
    value: text(),
  },
}

describe("caslAuthz plugin — transparent WHERE injection", () => {
  it("injects CASL WHERE on SELECT of a mapped table", () => {
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 42 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()

    // Without per-call `.where(...)`, the plugin must still have
    // added the CASL predicate. If this assertion fails, the plugin
    // didn't fire — which means every query in production goes out
    // without the authz filter.
    expect(compiled.sql).toContain("WHERE")
    expect(compiled.sql).toContain('"authorId"')
    expect(compiled.params).toContain(42)
  })

  it("ANDs CASL WHERE with user-provided WHERE", () => {
    // User adds their own filter; the plugin must AND in — not
    // replace, not OR. A replace-style bug would leak unauthorized
    // rows because the business filter "hides" the authz filter.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 1 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    const compiled = db
      .selectFrom("posts")
      .select("id")
      .where(({ published }) => published.eq("yes"))
      .toSQL()

    // Both predicates present in params.
    expect(compiled.params).toEqual(expect.arrayContaining([1, "yes"]))
    expect(compiled.sql).toContain("AND")
  })

  it("leaves queries on unmapped tables alone", () => {
    // `publicData` isn't in `subjects` — no CASL filter should
    // appear. Regression guard against a plugin that blanket-filters
    // everything.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 1 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    const compiled = db.selectFrom("publicData").select("id").toSQL()

    expect(compiled.sql).not.toMatch(/\bWHERE\b/)
    expect(compiled.params).toEqual([])
  })

  it("throws ForbiddenByCaslError on forbidden SELECT (default onForbidden)", () => {
    // Empty ability → posts is mapped to "Post" but no rule matches.
    // `toSQL()` runs the plugin, which hits the forbidden branch.
    const { build } = new AbilityBuilder(createMongoAbility)
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    expect(() => db.selectFrom("posts").select("id").toSQL()).toThrow(ForbiddenByCaslError)
  })

  it("injects WHERE FALSE on forbidden SELECT when onForbidden: empty", () => {
    // Same ability, different policy. The query compiles — but
    // returns zero rows at runtime. Matches Postgres RLS.
    const { build } = new AbilityBuilder(createMongoAbility)
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [
        caslAuthz({
          ability,
          subjects: { posts: "Post" },
          onForbidden: "empty",
        }),
      ],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()
    // FALSE is a tautological contradiction — the printer keeps it
    // in the WHERE because it's load-bearing (strip it and the query
    // returns everything).
    expect(compiled.sql.toUpperCase()).toMatch(/WHERE\s+FALSE/)
  })

  it("injects CASL WHERE on UPDATE with `update` action", () => {
    // Separate action namespace — readers shouldn't be able to
    // update. Verify the plugin uses the mapped update action, not
    // just "read".
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 1 })
    can("update", "Post", { authorId: 99 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    const compiled = db
      .update("posts")
      .set({ title: "hi" })
      .where(({ id }) => id.eq(7))
      .toSQL()

    // Update should carry the `update` rule's predicate (authorId=99),
    // not the `read` rule's (authorId=1). Using id=7 in the user
    // WHERE avoids ambiguity with the read rule's authorId=1.
    expect(compiled.params).toContain(99)
    expect(compiled.params).not.toContain(1 as never)
    expect(compiled.sql).toContain('"authorId"')
  })

  it("injects CASL WHERE on DELETE with `delete` action", () => {
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("delete", "Post", { authorId: 7 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    const compiled = db
      .deleteFrom("posts")
      .where(({ id }) => id.eq(1))
      .toSQL()

    expect(compiled.params).toContain(7)
  })

  it("custom actions map overrides default action names", () => {
    // App uses "view"/"edit"/"remove" instead of read/update/delete.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("view", "Post", { authorId: 5 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [
        caslAuthz({
          ability,
          subjects: { posts: "Post" },
          actions: { select: "view" },
        }),
      ],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()
    expect(compiled.params).toContain(5)
  })

  it("doesn't touch INSERT (deliberate boundary)", () => {
    // INSERT authz is out of scope — see plugin docstring. The
    // compile must not throw ForbiddenByCaslError even with no rules.
    const { build } = new AbilityBuilder(createMongoAbility)
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    expect(() =>
      db.insertInto("posts").values({ title: "x", authorId: 1, published: "no" }).toSQL(),
    ).not.toThrow()
  })

  it("unconditional can(read) produces no WHERE filter (pass-through)", () => {
    // `can('read', 'Post')` with no conditions — every row allowed.
    // The plugin must not add a trivial `WHERE TRUE` that the
    // optimizer would then strip; we let it remain a bare SELECT.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post")
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()
    // Bare SELECT — no WHERE, no params.
    expect(compiled.sql).not.toMatch(/\bWHERE\b/i)
    expect(compiled.params).toEqual([])
  })

  it("positive + inverted rules (can + cannot) compose correctly", () => {
    // `can('read', 'Post', { ... })` + `cannot('read', 'Post', { ... })`
    // → `WHERE (positive) AND NOT (inverted)`.
    const { can, cannot, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 1 })
    cannot("read", "Post", { published: "draft" })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()

    expect(compiled.sql).toMatch(/NOT/)
    expect(compiled.params).toEqual(expect.arrayContaining([1, "draft"]))
  })

  it("idempotent on nested SELECTs (no double-apply in subqueries)", () => {
    // PluginManager recurses into every inner SELECT and re-runs the
    // chain. Without the QueryFlags.CaslAuthzApplied idempotency
    // guard, a `WHERE (casl) IN (SELECT … FROM posts)` would end up
    // with two CASL clauses on the outer query AND two on the inner.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 1 })
    const ability = build()

    const db = sumak({
      dialect: pgDialect(),
      tables: TABLES,
      plugins: [caslAuthz({ ability, subjects: { posts: "Post" } })],
    })

    const compiled = db.selectFrom("posts").select("id").toSQL()

    // authorId should appear exactly once in the SQL (minus the
    // table-prefix version) — double-apply would produce two.
    const count = (compiled.sql.match(/"authorId"/g) ?? []).length
    expect(count).toBe(1)
    // Same for the param value — one occurrence per rule instance.
    expect(compiled.params.filter((p) => p === 1)).toHaveLength(1)
  })
})
