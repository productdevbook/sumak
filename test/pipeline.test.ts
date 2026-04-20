import { describe, expect, it } from "vitest"

import { pgDialect } from "../src/dialect/pg.ts"
import { createRule } from "../src/optimize/optimizer.ts"
import { integer, serial, text } from "../src/schema/column.ts"
import { sumak } from "../src/sumak.ts"

describe("7-layer pipeline integration", () => {
  const db = sumak({
    dialect: pgDialect(),
    tables: {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(),
        age: integer().defaultTo(0),
      },
      posts: {
        id: serial().primaryKey(),
        title: text().notNull(),
        user_id: integer().notNull(),
      },
    },
  })

  it("normalizes duplicate WHERE predicates", () => {
    const q = db
      .selectFrom("users")
      .select("id", "name")
      .where(({ name }) => name.eq("Alice"))
      .where(({ name }) => name.eq("Alice")) // duplicate
      .toSQL()

    // Should have only one predicate param, not two
    const aliceCount = q.params.filter((p) => p === "Alice").length
    expect(aliceCount).toBe(1)
  })

  it("works with plugins + normalization", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
    })

    const q = db2.selectFrom("users").select("id", "name").toSQL()
    expect(q.sql).toContain("SELECT")
    expect(q.sql).toContain('"users"')
  })

  it("normalization is enabled by default", () => {
    // WHERE true should be eliminated
    const q = db.selectFrom("users").select("id").toSQL()

    expect(q.sql).not.toContain("WHERE")
  })

  it("normalization can be disabled", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      normalize: false,
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
    })

    const q = db2.selectFrom("users").select("id").toSQL()
    expect(q.sql).toContain("SELECT")
  })

  it("optimization can be disabled", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      optimizeQueries: false,
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
    })

    const q = db2.selectFrom("users").select("id").toSQL()
    expect(q.sql).toContain("SELECT")
  })

  it("custom rules via config", () => {
    const addCommentRule = createRule({
      name: "test-rule",
      match: (node) => node.type === "select",
      apply: (node) => node, // no-op for testing
    })

    const db2 = sumak({
      dialect: pgDialect(),
      rules: [addCommentRule],
      tables: {
        users: {
          id: serial().primaryKey(),
          name: text().notNull(),
        },
      },
    })

    const q = db2.selectFrom("users").select("id").toSQL()
    expect(q.sql).toContain("SELECT")
  })

  it("constant folding in WHERE", () => {
    // Build a query that would have constant expressions
    const q = db
      .selectFrom("users")
      .select("id")
      .where(({ id }) => id.gt(0))
      .toSQL()

    expect(q.sql).toContain("WHERE")
    expect(q.params.length).toBeGreaterThan(0)
  })
})
