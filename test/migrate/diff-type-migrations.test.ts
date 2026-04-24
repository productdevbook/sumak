import { describe, expect, it } from "vitest"

import { sql } from "../../src/builder/sql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { diffSchemas } from "../../src/migrate/diff.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

function compile(nodes: { type: string }[], dialect = pgDialect()) {
  const db = sumak({ dialect, tables: {} })
  return nodes.map(
    (n) => (db.compileDDL(n as Parameters<typeof db.compileDDL>[0]) as { sql: string }).sql,
  )
}

describe("diffSchemas — typeMigrations / USING", () => {
  it("PG: ALTER COLUMN TYPE … USING gets emitted when the caller opts in", () => {
    const before = {
      users: { id: serial().primaryKey(), age: text().notNull() },
    }
    const after = {
      users: { id: serial().primaryKey(), age: integer().notNull() },
    }
    const nodes = diffSchemas(before, after, {
      typeMigrations: { "users.age": { using: sql`age::int` } },
    })
    const [ddl] = compile(nodes)
    expect(ddl).toMatch(/SET DATA TYPE\s+integer/i)
    expect(ddl).toMatch(/USING/i)
    expect(ddl).toMatch(/age::int/)
  })

  it("PG: type change with no USING still emits a bare SET DATA TYPE", () => {
    const before = { users: { id: serial().primaryKey(), age: text().notNull() } }
    const after = { users: { id: serial().primaryKey(), age: integer().notNull() } }
    const [ddl] = compile(diffSchemas(before, after))
    expect(ddl).toMatch(/SET DATA TYPE\s+integer/i)
    expect(ddl).not.toMatch(/USING/i)
  })
})
