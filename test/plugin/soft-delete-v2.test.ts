import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { SoftDeletePlugin } from "../../src/plugin/soft-delete.ts"
import { integer, serial, text, timestamptz } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("SoftDeletePlugin v2 — DELETE to UPDATE conversion", () => {
  const db = sumak({
    dialect: pgDialect(),
    plugins: [new SoftDeletePlugin({ tables: ["users"], mode: "convert" })],
    tables: {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(),
        deleted_at: timestamptz(),
      },
    },
  })

  it("SELECT adds WHERE deleted_at IS NULL", () => {
    const q = db.selectFrom("users").select("id", "name").toSQL()
    expect(q.sql).toContain("IS NULL")
    expect(q.sql).toContain('"deleted_at"')
  })

  it("UPDATE adds WHERE deleted_at IS NULL", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain("IS NULL")
  })

  it("DELETE converts to UPDATE SET deleted_at = NOW()", () => {
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    // Should be UPDATE, not DELETE
    expect(q.sql).toContain("UPDATE")
    expect(q.sql).toContain("SET")
    expect(q.sql).toContain("NOW()")
    expect(q.sql).not.toContain("DELETE")
  })

  it("DELETE without WHERE still converts", () => {
    const q = db.compile(db.deleteFrom("users").build())
    expect(q.sql).toContain("UPDATE")
    expect(q.sql).toContain("NOW()")
    expect(q.sql).toContain("IS NULL")
  })

  it("non-configured table DELETE is not converted", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [new SoftDeletePlugin({ tables: ["posts"], mode: "convert" })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db2
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain("DELETE")
    expect(q.sql).not.toContain("UPDATE")
  })
})

describe("SoftDeletePlugin — filter mode (backward compat)", () => {
  const db = sumak({
    dialect: pgDialect(),
    plugins: [new SoftDeletePlugin({ tables: ["users"], mode: "filter" })],
    tables: {
      users: { id: serial().primaryKey(), name: text().notNull() },
    },
  })

  it("DELETE in filter mode just adds WHERE, no conversion", () => {
    const q = db
      .deleteFrom("users")
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain("DELETE")
    expect(q.sql).toContain("IS NULL")
    expect(q.sql).not.toContain("UPDATE")
  })
})
