import { describe, expect, it } from "vitest"

import { col, eq, param } from "../../src/ast/expression.ts"
import type { ASTNode } from "../../src/ast/nodes.ts"
import { deleteFrom } from "../../src/builder/delete.ts"
import { insert } from "../../src/builder/insert.ts"
import { select } from "../../src/builder/select.ts"
import { update } from "../../src/builder/update.ts"
import { WithSchemaPlugin } from "../../src/plugin/with-schema.ts"
import { PgPrinter } from "../../src/printer/pg.ts"

const pg = new PgPrinter()
const plugin = new WithSchemaPlugin("public")

function compile(node: ASTNode): string {
  const transformed = plugin.transformNode(node)
  return pg.print(transformed).sql
}

describe("WithSchemaPlugin", () => {
  it("adds schema to SELECT FROM", () => {
    const node = select("id").from("users").build()
    const sql = compile(node)
    expect(sql).toContain('"public"."users"')
  })

  it("adds schema to JOIN tables", () => {
    const node = select()
      .from("users")
      .innerJoin("posts", eq(col("users.id"), col("posts.user_id")))
      .build()
    const sql = compile(node)
    expect(sql).toContain('"public"."users"')
    expect(sql).toContain('"public"."posts"')
  })

  it("adds schema to INSERT INTO", () => {
    const node = insert("users").columns("name").values("Alice").build()
    const sql = compile(node)
    expect(sql).toContain('"public"."users"')
  })

  it("adds schema to UPDATE", () => {
    const node = update("users").set("name", param(0, "Bob")).build()
    const sql = compile(node)
    expect(sql).toContain('"public"."users"')
  })

  it("adds schema to DELETE FROM", () => {
    const node = deleteFrom("users").build()
    const sql = compile(node)
    expect(sql).toContain('"public"."users"')
  })

  it("does not override existing schema", () => {
    const node = select().from({ type: "table_ref", name: "users", schema: "custom" }).build()
    const sql = compile(node)
    expect(sql).toContain('"custom"."users"')
    expect(sql).not.toContain('"public"')
  })
})
