import { describe, expect, it } from "vitest"

import { col, eq, param } from "../../src/ast/expression.ts"
import { MergeBuilder } from "../../src/builder/merge.ts"
import { MssqlPrinter } from "../../src/printer/mssql.ts"
import { PgPrinter } from "../../src/printer/pg.ts"

function pgPrinter() {
  return new PgPrinter()
}

function mssqlPrinter() {
  return new MssqlPrinter()
}

describe("MergeBuilder", () => {
  it("builds basic MERGE with WHEN MATCHED UPDATE", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: col("name", "s") }])
      .build()

    const r = pgPrinter().print(node)
    expect(r.sql).toContain("MERGE INTO")
    expect(r.sql).toContain("USING")
    expect(r.sql).toContain("WHEN MATCHED THEN UPDATE SET")
  })

  it("builds MERGE with WHEN NOT MATCHED INSERT", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenNotMatchedInsert(["name", "email"], [col("name", "s"), col("email", "s")])
      .build()

    const r = pgPrinter().print(node)
    expect(r.sql).toContain("WHEN NOT MATCHED THEN INSERT")
    expect(r.sql).toContain("VALUES")
  })

  it("builds MERGE with WHEN MATCHED DELETE", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedDelete()
      .build()

    const r = pgPrinter().print(node)
    expect(r.sql).toContain("WHEN MATCHED THEN DELETE")
  })

  it("builds MERGE with multiple WHEN clauses", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: col("name", "s") }])
      .whenNotMatchedInsert(["name"], [col("name", "s")])
      .build()

    const r = pgPrinter().print(node)
    expect(r.sql).toContain("WHEN MATCHED")
    expect(r.sql).toContain("WHEN NOT MATCHED")
  })

  it("works with MSSQL dialect", () => {
    const node = new MergeBuilder()
      .into("users")
      .using("staging", "s")
      .on(eq(col("id", "users"), col("id", "s")))
      .whenMatchedUpdate([{ column: "name", value: param(0, "Bob") }])
      .whenNotMatchedInsert(["name"], [param(1, "Alice")])
      .build()

    const r = mssqlPrinter().print(node)
    expect(r.sql).toContain("[users]")
    expect(r.sql).toContain("[staging]")
    expect(r.sql).toContain("@p0")
    expect(r.sql).toContain("@p1")
    expect(r.params).toEqual(["Bob", "Alice"])
  })
})
