import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { AuditTimestampPlugin } from "../../src/plugin/audit-timestamp.ts"
import { serial, text, timestamptz } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

describe("AuditTimestampPlugin", () => {
  const db = sumak({
    dialect: pgDialect(),
    plugins: [new AuditTimestampPlugin({ tables: ["users"] })],
    tables: {
      users: {
        id: serial().primaryKey(),
        name: text().notNull(),
        created_at: timestamptz().nullable(),
        updated_at: timestamptz().nullable(),
      },
    },
  })

  it("INSERT adds created_at and updated_at", () => {
    const q = db.insertInto("users").values({ name: "Alice" }).toSQL()
    expect(q.sql).toContain('"created_at"')
    expect(q.sql).toContain('"updated_at"')
    expect(q.sql).toContain("NOW()")
  })

  it("UPDATE adds updated_at = NOW()", () => {
    const q = db
      .update("users")
      .set({ name: "Bob" })
      .where(({ id }) => id.eq(1))
      .toSQL()
    expect(q.sql).toContain('"updated_at"')
    expect(q.sql).toContain("NOW()")
  })

  it("SELECT is not affected", () => {
    const q = db.selectFrom("users").select("id").toSQL()
    expect(q.sql).not.toContain("NOW()")
  })

  it("non-configured table is not affected", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [new AuditTimestampPlugin({ tables: ["posts"] })],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db2.insertInto("users").values({ name: "Alice" }).toSQL()
    expect(q.sql).not.toContain("created_at")
  })

  it("custom column names", () => {
    const db2 = sumak({
      dialect: pgDialect(),
      plugins: [
        new AuditTimestampPlugin({
          tables: ["users"],
          createdAt: "createdAt",
          updatedAt: "updatedAt",
        }),
      ],
      tables: {
        users: { id: serial().primaryKey(), name: text().notNull() },
      },
    })
    const q = db2.insertInto("users").values({ name: "Alice" }).toSQL()
    expect(q.sql).toContain('"createdAt"')
    expect(q.sql).toContain('"updatedAt"')
  })
})
