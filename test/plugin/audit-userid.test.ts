import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { audit } from "../../src/plugin/factories.ts"
import { integer, serial, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// audit() grew `userId: () => unknown` alongside the existing
// timestamp columns. When set, every INSERT/UPDATE on a configured
// table carries the user id into `created_by` / `updated_by`. When
// unset (or when the resolver returns undefined), the columns are
// omitted — a NULL write would collide with a NOT NULL column on
// schemas that introduced those later.

function build(userId?: () => unknown) {
  return sumak({
    dialect: pgDialect(),
    plugins: [audit({ tables: ["posts"], userId })],
    tables: {
      posts: {
        id: serial().primaryKey(),
        title: text().notNull(),
        created_at: timestamp().nullable(),
        updated_at: timestamp().nullable(),
        created_by: integer().nullable(),
        updated_by: integer().nullable(),
      },
    },
  })
}

describe("audit — userId injection", () => {
  it("no userId resolver — INSERT only carries created_at / updated_at", () => {
    const db = build()
    const { sql, params } = db.insertInto("posts").values({ title: "hi" }).toSQL()
    expect(sql).toMatch(/"title"/)
    expect(sql).toMatch(/"created_at"/)
    expect(sql).toMatch(/"updated_at"/)
    expect(sql).not.toMatch(/"created_by"/)
    expect(sql).not.toMatch(/"updated_by"/)
    // Only the user-supplied `title` param survives.
    expect(params).toEqual(["hi"])
  })

  it("userId resolver — INSERT adds created_by and updated_by with the resolved id", () => {
    const db = build(() => 42)
    const { sql, params } = db.insertInto("posts").values({ title: "hi" }).toSQL()
    expect(sql).toMatch(/"created_by"/)
    expect(sql).toMatch(/"updated_by"/)
    // Params: title, then created_by, then updated_by — driver-side
    // binding relies on this exact order.
    expect(params).toEqual(["hi", 42, 42])
  })

  it("UPDATE adds updated_by to the SET list when userId resolves", () => {
    const db = build(() => 7)
    const { sql, params } = db
      .update("posts")
      .set({ title: "new" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(sql).toMatch(/"updated_at"/)
    expect(sql).toMatch(/"updated_by"/)
    expect(params).toEqual(["new", 7, 1])
  })

  it("userId resolver returning undefined is treated as 'no current user'", () => {
    const db = build(() => undefined)
    const { sql, params } = db.insertInto("posts").values({ title: "hi" }).toSQL()
    expect(sql).not.toMatch(/"created_by"/)
    expect(params).toEqual(["hi"])
  })

  it("custom column names — createdBy / updatedBy overrides propagate", () => {
    const db = sumak({
      dialect: pgDialect(),
      plugins: [
        audit({
          tables: ["posts"],
          userId: () => 1,
          createdBy: "author_id",
          updatedBy: "last_editor_id",
        }),
      ],
      tables: {
        posts: {
          id: serial().primaryKey(),
          title: text().notNull(),
          author_id: integer().nullable(),
          last_editor_id: integer().nullable(),
        },
      },
    })
    const { sql } = db.insertInto("posts").values({ title: "hi" }).toSQL()
    expect(sql).toMatch(/"author_id"/)
    expect(sql).toMatch(/"last_editor_id"/)
    expect(sql).not.toMatch(/"created_by"/)
  })
})
