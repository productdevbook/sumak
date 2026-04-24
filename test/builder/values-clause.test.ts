import { describe, expect, it } from "vitest"

import { val, valuesClause } from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { InvalidExpressionError } from "../../src/errors.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("valuesClause + selectFromValues", () => {
  const db = sumak({ dialect: pgDialect(), tables: { stub: { id: serial().primaryKey() } } })

  it("builds a (VALUES (...)) AS alias(cols) derived table", () => {
    const seed = valuesClause({
      alias: "seed",
      columns: ["id", "label"],
      rows: [
        [val(1), val("one")],
        [val(2), val("two")],
      ],
    })
    const { sql } = db.selectFromValues(seed).selectAll().toSQL()
    expect(sql).toMatch(/VALUES/)
    expect(sql).toMatch(/'one'/)
    expect(sql).toMatch(/'two'/)
    expect(sql).toMatch(/AS "seed"/)
    expect(sql).toMatch(/"id"/)
    expect(sql).toMatch(/"label"/)
  })

  it("rejects an empty rows array", () => {
    expect(() => valuesClause({ alias: "x", columns: ["a"], rows: [] })).toThrow(
      InvalidExpressionError,
    )
  })

  it("rejects an empty columns list", () => {
    expect(() => valuesClause({ alias: "x", columns: [], rows: [[val(1)]] as never })).toThrow(
      InvalidExpressionError,
    )
  })

  it("rejects row-arity mismatch", () => {
    expect(() =>
      valuesClause({
        alias: "x",
        columns: ["a", "b"],
        rows: [[val(1), val(2)], [val(3)]] as never,
      }),
    ).toThrow(/row 1 has 1 values but columns list has 2/)
  })
})

describe("VALUES as a JOIN source", () => {
  const db = sumak({
    dialect: pgDialect(),
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull(), score: integer().notNull() },
    },
  })

  it("JOIN (VALUES ...) AS tiers(min_score, label) compiles", () => {
    const tiers = valuesClause({
      alias: "tiers",
      columns: ["min_score", "label"],
      rows: [
        [val(0), val("bronze")],
        [val(100), val("silver")],
        [val(1000), val("gold")],
      ],
    })
    // Use the low-level SelectBuilder to attach the VALUES as a JOIN.
    // The typed builder doesn't surface this form yet; covering the
    // AST path here keeps the contract solid.
    const core = db.selectFrom("users").build()
    core.joins.push({
      type: "join",
      joinType: "CROSS",
      table: tiers,
    })
    const { sql } = db.compile(core)
    expect(sql).toMatch(/VALUES/)
    expect(sql).toMatch(/"tiers"/)
    expect(sql).toMatch(/CROSS JOIN/)
  })
})
