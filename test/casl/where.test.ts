import { AbilityBuilder, createMongoAbility } from "@casl/ability"
import { describe, expect, it } from "vitest"

import { ForbiddenByCaslError, caslToSumakWhere } from "../../src/casl/where.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"

// Real CASL abilities back these tests. The point is to pin the
// contract against `@casl/ability`'s actual `rulesToAST` output, not
// a hand-rolled shim — if CASL's ucast emission changes, the
// converter's guesses about FieldCondition/CompoundCondition shape
// need to break loudly here, not silently in a downstream app.

const TABLES = {
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    authorId: serial(),
    published: text(),
    deletedAt: text(),
  },
}

describe("caslToSumakWhere — end-to-end with real @casl/ability", () => {
  it("single condition → WHERE with parameter", () => {
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 1 })
    const ability = build()

    const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })

    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const compiled = db
      .selectFrom("posts")
      .select("id")
      .where(() => where)
      .toSQL()

    // The rules-to-query contract: authorId gets parameterized, no
    // inlining. If this assertion ever breaks with a literal 1 in the
    // SQL, the converter has regressed on its parameterization
    // guarantee and CASL-authed rules become SQL-injection-adjacent.
    expect(compiled.sql).toContain("WHERE")
    expect(compiled.sql).toContain('"authorId"')
    expect(compiled.params).toContain(1)
  })

  it("OR branch → SELECT WHERE ( … OR … )", () => {
    // Canonical CASL pattern: multiple `can` rules for the same
    // (action, subject) OR together. The ucast tree comes out as a
    // CompoundCondition("or", [...]) — exercising our compound code path.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { published: true })
    can("read", "Post", { authorId: 1 })
    const ability = build()

    const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const compiled = db
      .selectFrom("posts")
      .select("id")
      .where(() => where)
      .toSQL()

    // We don't pin the exact SQL shape (OR associativity varies with
    // how rulesToAST nests) but we do verify both clauses made it in.
    expect(compiled.sql).toContain("OR")
    expect(compiled.params).toContain(true)
    expect(compiled.params).toContain(1)
  })

  it("cannot(...) → inverted rule threaded through AND NOT", () => {
    // `cannot` produces a rule with `inverted: true`. `rulesToAST`
    // merges it into the tree as a negated clause — verifying our
    // `not` handling works against the real CASL output.
    const { can, cannot, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { authorId: 1 })
    cannot("read", "Post", { published: false })
    const ability = build()

    const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const compiled = db
      .selectFrom("posts")
      .select("id")
      .where(() => where)
      .toSQL()

    // The NOT can land either as `NOT (col = $x)` or via ucast's
    // inverted conditions — in both shapes the resulting SQL must
    // mention NOT somewhere to remain semantically correct.
    expect(compiled.sql).toMatch(/NOT/)
    // Both right-hand values (1 for authorId, false for published)
    // made it into params.
    expect(compiled.params).toContain(1)
    expect(compiled.params).toContain(false)
  })

  it("in operator with array → IN (...) clause", () => {
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { published: { $in: ["draft", "public"] } })
    const ability = build()

    const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const compiled = db
      .selectFrom("posts")
      .select("id")
      .where(() => where)
      .toSQL()

    expect(compiled.sql).toContain("IN")
    expect(compiled.params).toContain("draft")
    expect(compiled.params).toContain("public")
  })

  it("comparison operators — gt / gte / lt / lte come through", () => {
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { id: { $gt: 10, $lte: 100 } })
    const ability = build()

    const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const compiled = db
      .selectFrom("posts")
      .select("id")
      .where(() => where)
      .toSQL()

    expect(compiled.sql).toMatch(/>/)
    expect(compiled.sql).toMatch(/<=/)
    expect(compiled.params).toEqual(expect.arrayContaining([10, 100]))
  })

  it("forbidden subject (no matching rule) throws ForbiddenByCaslError", () => {
    // Empty ability — no rules match `read` on `Post`. `rulesToAST`
    // returns null; the utility throws so the caller can't pipe a
    // null into a query.
    const { build } = new AbilityBuilder(createMongoAbility)
    const ability = build()

    expect(() => caslToSumakWhere({ ability, action: "read", subject: "Post" })).toThrow(
      ForbiddenByCaslError,
    )
  })

  it("forbidden error carries action + subject for logging", () => {
    const { build } = new AbilityBuilder(createMongoAbility)
    const ability = build()
    try {
      caslToSumakWhere({ ability, action: "delete", subject: "Secret" })
      throw new Error("expected ForbiddenByCaslError")
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenByCaslError)
      const err = e as ForbiddenByCaslError
      expect(err.action).toBe("delete")
      expect(err.subject).toBe("Secret")
    }
  })

  it("eq-null collapses to IS NULL in the final SQL", () => {
    // Regression guard for the `$eq: null` → IS NULL rewrite. Without
    // it the generated SQL ends up as `"deletedAt" = NULL`, which is
    // always UNKNOWN in SQL three-valued logic → rule silently matches
    // nothing. That's a classic authz-bypass trap.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post", { deletedAt: null })
    const ability = build()

    const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const compiled = db
      .selectFrom("posts")
      .select("id")
      .where(() => where)
      .toSQL()

    expect(compiled.sql).toContain("IS NULL")
    // Importantly: no "= $1" with a null parameter — that's the bug
    // we're guarding against.
    expect(compiled.sql).not.toMatch(/=\s*\$\d+\s*$/)
  })

  it("unconditional rule (can read all) → WHERE TRUE (matches every row)", () => {
    // `can('read', 'Post')` with no conditions — probed against real
    // CASL: `rulesToAST` returns a `CompoundCondition("and", [])`.
    // Our converter collapses empty-AND to `literal(true)`, so the
    // final SQL ends up as `WHERE TRUE`. That's the right semantic
    // (authorized for everything → select all rows) and it composes
    // harmlessly if the caller ANDs it with business filters.
    //
    // Contrast with the "forbidden" case above: no matching rule →
    // `rulesToAST` returns literal `null` → we throw. The two cases
    // are distinct at the ucast layer, so we don't need to call
    // `ability.can(...)` to disambiguate.
    const { can, build } = new AbilityBuilder(createMongoAbility)
    can("read", "Post")
    const ability = build()

    const where = caslToSumakWhere({ ability, action: "read", subject: "Post" })
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const compiled = db
      .selectFrom("posts")
      .select("id")
      .where(() => where)
      .toSQL()

    // The emitted WHERE reduces to `TRUE`. Sumak's optimizer strips
    // tautological `WHERE TRUE` from the final SQL, so the output is
    // the bare SELECT — exactly what a no-conditions ability should
    // produce. Guard against a regression that would either (a) leave
    // a bogus `WHERE` in or (b) throw.
    expect(compiled.sql).not.toMatch(/\bWHERE\b/i)
    expect(compiled.params).toEqual([])
  })
})
