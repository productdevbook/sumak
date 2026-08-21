import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { and, or } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// The compile pipeline must be a pure function of query *shape*. A parameter's
// runtime value may only reach `params`, never the SQL string.
//
// Break this and two things fail at once: one call site starts emitting several
// different SQL texts, so the database cannot reuse a prepared statement's
// plan, and nothing downstream can cache a compiled query.
//
// It has been broken twice, both times inside `deduplicatePredicates`. The
// fingerprint for a parameter was its value, so `id = 1 AND id = 1` collapsed
// to one predicate while `id = 1 AND id = 2` kept two. The IN(...) fast path
// fingerprinted by arity alone, so `id IN (1,2) AND id IN (3,4)` silently
// dropped the second list — wrong rows, not merely a different string.

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      age: integer().notNull(),
    },
  },
})

describe("compiled SQL is independent of parameter values", () => {
  it("two equality predicates on one column survive equal values", () => {
    const compile = (a: number, b: number) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ id }) => and(id.eq(a), id.eq(b)))
        .toSQL()

    expect(compile(1, 1).sql).toBe(compile(1, 2).sql)
    expect(compile(1, 1).params).toEqual([1, 1])
  })

  it("two IN lists on one column are both emitted", () => {
    const q = db
      .selectFrom("users")
      .selectAll()
      .where(({ id }) => and(id.in([1, 2]), id.in([3, 4])))
      .toSQL()

    expect(q.params).toEqual([1, 2, 3, 4])
    expect(q.sql).toContain("IN ($1, $2)")
    expect(q.sql).toContain("IN ($3, $4)")
  })

  it("IN lists of equal arity on one column stay distinct", () => {
    const compile = (xs: number[], ys: number[]) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ id }) => and(id.in(xs), id.in(ys)))
        .toSQL()

    expect(compile([1, 2], [3, 4]).sql).toBe(compile([9, 9], [9, 9]).sql)
  })

  const shapes: Record<string, (v: readonly [number, number, string]) => string> = {
    "single eq": ([a]) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ id }) => id.eq(a))
        .toSQL().sql,
    "and chain": ([a, b, c]) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ id, age, name }) => and(id.eq(a), age.gt(b), name.neq(c)))
        .toSQL().sql,
    "or chain": ([a, b, c]) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ id, age, name }) => or(id.eq(a), age.gt(b), name.eq(c)))
        .toSQL().sql,
    "repeated column": ([a, b]) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ age }) => and(age.gt(a), age.lt(b)))
        .toSQL().sql,
    "chained where": ([a, b]) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ id }) => id.eq(a))
        .where(({ age }) => age.gt(b))
        .toSQL().sql,
    "in list": ([a, b]) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ id }) => id.in([a, b]))
        .toSQL().sql,
    between: ([a, b]) =>
      db
        .selectFrom("users")
        .selectAll()
        .where(({ age }) => age.between(a, b))
        .toSQL().sql,
    "update set": ([a, b]) =>
      db
        .update("users")
        .set({ age: a })
        .where(({ id }) => id.eq(b))
        .toSQL().sql,
    "delete where": ([a, b]) =>
      db
        .deleteFrom("users")
        .where(({ id, age }) => and(id.eq(a), age.gt(b)))
        .toSQL().sql,
  }

  const values = fc.tuple(
    fc.integer({ min: -50, max: 50 }),
    fc.integer({ min: -50, max: 50 }),
    fc.string({ maxLength: 8 }),
  )

  for (const [name, compile] of Object.entries(shapes)) {
    it(`${name}: same shape, any values, one SQL string`, () => {
      const reference = compile([0, 0, ""])
      fc.assert(
        fc.property(values, (v) => {
          expect(compile(v)).toBe(reference)
        }),
        { numRuns: 200 },
      )
    })
  }
})
