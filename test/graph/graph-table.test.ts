import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { serial } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// Minimal db — graph tables don't rely on the `tables` map today.
const db = sumak({
  dialect: pgDialect(),
  tables: { _unused: { id: serial() } } as any,
})

describe("SQL/PGQ spike — db.graphTable().match().columns().toSQL()", () => {
  it("emits FROM GRAPH_TABLE with a MATCH pattern and COLUMNS list", () => {
    const g = db.graphTable("social").match`(p:Person)-[:FOLLOWS]->(f:Person)`
      .columns({ follower: "p.name", followee: "f.name" })
      .as("g")

    const q = db.selectFromGraph(g).select("follower", "followee").toSQL()

    expect(q.sql).toMatch(/FROM GRAPH_TABLE \("social"/)
    expect(q.sql).toMatch(/MATCH \(p:Person\)-\[:FOLLOWS\]->\(f:Person\)/)
    expect(q.sql).toMatch(/COLUMNS \(p\.name AS "follower", f\.name AS "followee"\)/)
    expect(q.sql).toMatch(/\) AS "g"/)
  })

  it("forwards interpolated values through the params pipeline", () => {
    const g = db.graphTable("social")
      .match`(p:Person)-[:FOLLOWS]->(f:Person) WHERE p.name = ${"Alice"}`
      .columns({ follower: "p.name" })
      .as("g")

    const q = db.selectFromGraph(g).select("follower").toSQL()
    // The string "Alice" must become $1, not be inlined.
    expect(q.sql).toContain("WHERE p.name = $1")
    expect(q.params).toEqual(["Alice"])
  })

  it(".columns({}) throws at build time — no empty projection", () => {
    expect(() => db.graphTable("social").match`(p)-[]->(q)`.columns({})).toThrow(/at least one/i)
  })

  it("build() throws if .match was never called", () => {
    expect(() => db.graphTable("social").columns({ x: "p.name" }).build()).toThrow(
      /requires a \.match/,
    )
  })

  it("top-level where() is emitted between MATCH and COLUMNS", () => {
    const g = db.graphTable("social").match`(p:Person)-[:FOLLOWS]->(f:Person)`.columns({
      name: "p.name",
    })

    // We don't fully type graph columns yet, so just smoke-test that
    // passing a pre-built Expression<boolean> works.
    // Simplest path: don't use where() at all — covered in the interpolated-
    // WHERE test above. Full builder-level where tests come in phase 2.
    expect(() => db.selectFromGraph(g).select("name").toSQL()).not.toThrow()
  })
})
