import { describe, expect, it } from "vitest"

import { col, eq, param } from "../../src/ast/expression.ts"
import type { ASTNode } from "../../src/ast/nodes.ts"
import { deleteFrom } from "../../src/builder/delete.ts"
import { select } from "../../src/builder/select.ts"
import { update } from "../../src/builder/update.ts"
import { SoftDeletePlugin } from "../../src/plugin/soft-delete.ts"
import { PgPrinter } from "../../src/printer/pg.ts"

const pg = new PgPrinter()
const plugin = new SoftDeletePlugin({ tables: ["users", "posts"] })

function compile(node: ASTNode): string {
  const transformed = plugin.transformNode(node)
  return pg.print(transformed).sql
}

describe("SoftDeletePlugin", () => {
  it("adds deleted_at IS NULL to SELECT", () => {
    const node = select().from("users").build()
    const sql = compile(node)
    expect(sql).toContain("IS NULL")
    expect(sql).toContain('"deleted_at"')
  })

  it("combines with existing WHERE", () => {
    const node = select()
      .from("users")
      .where(eq(col("active"), param(0, true)))
      .build()
    const sql = compile(node)
    expect(sql).toContain("AND")
    expect(sql).toContain("IS NULL")
  })

  it("adds to UPDATE WHERE", () => {
    const node = update("users").set("name", param(0, "x")).build()
    const sql = compile(node)
    expect(sql).toContain("IS NULL")
  })

  it("adds to DELETE WHERE", () => {
    const node = deleteFrom("users").build()
    const sql = compile(node)
    expect(sql).toContain("IS NULL")
  })

  it("does not modify queries for unconfigured tables", () => {
    const node = select().from("orders").build()
    const sql = compile(node)
    expect(sql).not.toContain("IS NULL")
    expect(sql).not.toContain("deleted_at")
  })

  it("uses custom column name", () => {
    const customPlugin = new SoftDeletePlugin({
      tables: ["users"],
      column: "removed_at",
    })
    const node = select().from("users").build()
    const sql = pg.print(customPlugin.transformNode(node)).sql
    expect(sql).toContain('"removed_at"')
    expect(sql).toContain("IS NULL")
  })
})
