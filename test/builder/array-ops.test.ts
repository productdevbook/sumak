import { describe, expect, it } from "vitest"

import {
  arrayContainedBy,
  arrayContains,
  arrayOverlaps,
  rawExpr,
  val,
} from "../../src/builder/eb.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      tags: text().notNull(),
    },
  },
})

const p = db.printer()

describe("PG array operators", () => {
  it("@> (arrayContains)", () => {
    const q = db
      .selectFrom("posts")
      .select("id")
      .where(() => arrayContains(rawExpr("tags"), rawExpr("ARRAY['sql', 'typescript']")))
      .compile(p)
    expect(q.sql).toContain("@>")
  })

  it("<@ (arrayContainedBy)", () => {
    const q = db
      .selectFrom("posts")
      .select("id")
      .where(() => arrayContainedBy(rawExpr("tags"), rawExpr("ARRAY['sql', 'typescript', 'rust']")))
      .compile(p)
    expect(q.sql).toContain("<@")
  })

  it("&& (arrayOverlaps)", () => {
    const q = db
      .selectFrom("posts")
      .select("id")
      .where(() => arrayOverlaps(rawExpr("tags"), rawExpr("ARRAY['sql']")))
      .compile(p)
    expect(q.sql).toContain("&&")
  })
})
