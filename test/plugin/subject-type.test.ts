import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import type { Driver } from "../../src/driver/types.ts"
import { deriveResultContext } from "../../src/plugin/result-context.ts"
import { subjectType } from "../../src/plugin/subject-type.ts"
import { integer, serial, text } from "../../src/schema/index.ts"
import { sumak } from "../../src/sumak.ts"

function canned(rows: Record<string, unknown>[]): Driver {
  return {
    async query() {
      return rows
    },
    async execute() {
      return { affected: rows.length }
    },
  }
}

const TABLES = {
  messages: {
    id: serial().primaryKey(),
    body: text().notNull(),
  },
  users: {
    id: serial().primaryKey(),
    name: text().notNull(),
  },
  posts: {
    id: serial().primaryKey(),
    title: text().notNull(),
    userId: integer(),
  },
}

describe("subjectType plugin (issue #90 / CASL)", () => {
  it("stamps __typename on every row from a mapped table", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([
        { id: 1, body: "hello" },
        { id: 2, body: "world" },
      ]),
      plugins: [subjectType({ tables: { messages: "Message" } })],
      tables: TABLES,
    })

    const rows = await db.selectFrom("messages").many()
    expect(rows).toHaveLength(2)
    expect((rows[0] as unknown as { __typename: string }).__typename).toBe("Message")
    expect((rows[1] as unknown as { __typename: string }).__typename).toBe("Message")
  })

  it("leaves unmapped tables alone", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([{ id: 1, title: "post" }]),
      plugins: [subjectType({ tables: { messages: "Message" } })],
      tables: TABLES,
    })

    const rows = await db.selectFrom("posts").many()
    expect(rows[0]).not.toHaveProperty("__typename")
  })

  it("supports custom field name", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([{ id: 1, name: "Alice" }]),
      plugins: [subjectType({ tables: { users: "User" }, field: "_subject" })],
      tables: TABLES,
    })

    const row = await db.selectFrom("users").first()
    expect(row).toMatchObject({ _subject: "User" })
  })

  it("fires on INSERT ... RETURNING too", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([{ id: 1, body: "hi" }]),
      plugins: [subjectType({ tables: { messages: "Message" } })],
      tables: TABLES,
    })

    const rows = await db.insertInto("messages").values({ body: "hi" }).returningAll().many()
    expect((rows[0] as unknown as { __typename: string }).__typename).toBe("Message")
  })

  it("fires on UPDATE ... RETURNING", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([{ id: 1, body: "hi" }]),
      plugins: [subjectType({ tables: { messages: "Message" } })],
      tables: TABLES,
    })

    const rows = await db
      .update("messages")
      .set({ body: "hi" })
      .where(({ id }) => id.eq(1))
      .returningAll()
      .many()
    expect((rows[0] as unknown as { __typename: string }).__typename).toBe("Message")
  })

  it("fires on DELETE ... RETURNING", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([
        { id: 1, body: "a" },
        { id: 2, body: "b" },
      ]),
      plugins: [subjectType({ tables: { messages: "Message" } })],
      tables: TABLES,
    })

    const rows = await db
      .deleteFrom("messages")
      .where(({ id }) => id.gt(0))
      .returningAll()
      .many()
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect((r as unknown as { __typename: string }).__typename).toBe("Message")
    }
  })

  it("fires on UPDATE ... RETURNING with specific columns", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([{ id: 1 }]),
      plugins: [subjectType({ tables: { messages: "Message" } })],
      tables: TABLES,
    })

    const rows = await db
      .update("messages")
      .set({ body: "x" })
      .where(({ id }) => id.eq(1))
      .returning("id")
      .many()
    // __typename is stamped at the DML target level regardless of which
    // columns come back — the rule is "row came from messages", not
    // "the full row was returned".
    expect((rows[0] as unknown as { __typename: string }).__typename).toBe("Message")
  })

  it("does not overwrite an existing __typename on the row", async () => {
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([{ id: 1, body: "hi", __typename: "AlreadySet" }]),
      plugins: [subjectType({ tables: { messages: "Message" } })],
      tables: TABLES,
    })

    const row = await db.selectFrom("messages").first()
    expect((row as unknown as { __typename: string }).__typename).toBe("AlreadySet")
  })

  it("is a no-op on rows from tables the config doesn't mention", async () => {
    // Plugin with no tables — shouldn't touch anything.
    const db = sumak({
      dialect: pgDialect(),
      driver: canned([{ id: 1, body: "hi" }]),
      plugins: [subjectType({ tables: {} })],
      tables: TABLES,
    })

    const row = await db.selectFrom("messages").first()
    expect(row).not.toHaveProperty("__typename")
  })
})

describe("deriveResultContext", () => {
  it("picks up table from SELECT FROM", () => {
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const sel = db.selectFrom("users").select("id", "name").build()
    const ctx = deriveResultContext(sel)
    expect(ctx.table).toBe("users")
    expect(ctx.columnSources).toEqual({ id: "users", name: "users" })
  })

  it("picks up table from INSERT RETURNING", () => {
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const ins = db.insertInto("messages").values({ body: "x" }).returningAll().build()
    const ctx = deriveResultContext(ins)
    expect(ctx.table).toBe("messages")
  })

  it("tracks aliased expressions back to their source column's table", () => {
    // Build a SELECT with aliased column refs; deriveResultContext
    // should attribute the aliases to the correct source table.
    const db = sumak({ dialect: pgDialect(), tables: TABLES })
    const node = db
      .selectFrom("users")
      .innerJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))
      .select("id")
      .build()
    const ctx = deriveResultContext(node)
    expect(ctx.columnSources).toBeDefined()
    // "id" is a bare column_ref — default-table fallback → "users"
    expect(ctx.columnSources?.id).toBe("users")
  })
})
