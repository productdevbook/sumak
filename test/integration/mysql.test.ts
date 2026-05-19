import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { and, count, val } from "../../src/builder/eb.ts"
import { mysqlDialect } from "../../src/dialect/mysql.ts"
import type { Mysql2Pool } from "../../src/drivers/mysql2.ts"
import { boolean, integer, jsonb, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

/**
 * Opt-in MySQL roundtrip suite. Mirrors a subset of the PGlite test
 * but speaks MySQL syntax. Wakes up only when `MYSQL_URL` points at a
 * reachable server, e.g.:
 *
 *   MYSQL_URL='mysql://root:pass@127.0.0.1:3306/sumak_test' pnpm vitest run test/integration/mysql.test.ts
 *
 * The user must have created the database and granted DROP / CREATE
 * privileges on it. No MySQL-equivalent of PGlite exists, so we lean
 * on the live server — the test file is gated to keep CI happy.
 *
 * `mysql2` is not in the project's devDependencies on purpose; it's
 * dynamically imported so a teammate without it installed sees the
 * gated tests skip cleanly, not crash on import.
 */

const MYSQL_URL = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env?.MYSQL_URL
const enabled = !!MYSQL_URL

const db = sumak({
  dialect: mysqlDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer().nullable(),
      active: boolean().defaultTo(true),
      meta: jsonb(),
    },
    posts: {
      id: serial().primaryKey(),
      title: text().notNull(),
      body: text(),
      userId: integer(),
    },
  },
})

const printer = db.printer()

let pool: Mysql2Pool

beforeAll(async () => {
  if (!enabled) return
  // Dynamic import so `mysql2` only resolves when the suite is
  // actually running. The package is intentionally not in
  // devDependencies — the runtime import string is built at call
  // time to keep the type checker from trying to resolve the
  // module statically.
  const moduleName = "mysql2/promise"
  const mysql = (await import(moduleName)) as {
    createPool: (url: string) => Mysql2Pool
  }
  pool = mysql.createPool(MYSQL_URL!)

  // Re-create schema each run. MySQL doesn't have transactional DDL,
  // so we can't wrap this in a transaction — just drop + create.
  const conn = await pool.getConnection()
  try {
    await conn.query("DROP TABLE IF EXISTS posts")
    await conn.query("DROP TABLE IF EXISTS users")
    await conn.query(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        age INT,
        active BOOLEAN DEFAULT true,
        meta JSON
      )
    `)
    await conn.query(`
      CREATE TABLE posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT,
        userId INT,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `)
    await conn.query(`
      INSERT INTO users (name, email, age, active, meta) VALUES
        ('Alice', 'alice@example.com', 30, true, '{"role": "admin"}'),
        ('Bob', 'bob@example.com', 25, true, '{"role": "user"}'),
        ('Charlie', 'charlie@example.com', 35, false, NULL)
    `)
    await conn.query(`
      INSERT INTO posts (title, body, userId) VALUES
        ('Hello World', 'First post', 1),
        ('Second Post', 'Another one', 1),
        ('Bob Post', 'From Bob', 2)
    `)
  } finally {
    conn.release()
  }
})

afterAll(async () => {
  if (!enabled) return
  await (pool as unknown as { end?: () => Promise<void> }).end?.()
})

async function run(query: {
  sql: string
  params: readonly unknown[]
}): Promise<{ rows: Record<string, unknown>[] }> {
  const [rows] = await pool.query(query.sql, query.params)
  if (Array.isArray(rows)) return { rows: rows as Record<string, unknown>[] }
  return { rows: [] }
}

describe.skipIf(!enabled)("MySQL integration — SELECT", () => {
  it("SELECT all rows", async () => {
    const q = db.selectFrom("users").compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(3)
  })

  it("WHERE eq", async () => {
    const q = db
      .selectFrom("users")
      .where(({ id }) => id.eq(1))
      .compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].name).toBe("Alice")
  })

  it("WHERE gt + AND", async () => {
    const q = db
      .selectFrom("users")
      .where(({ age, active }) => and(age.gt(20), active.eq(true)))
      .compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(2)
  })

  it("WHERE IN", async () => {
    const q = db
      .selectFrom("users")
      .where(({ id }) => id.in([1, 3]))
      .compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(2)
  })

  it("WHERE LIKE", async () => {
    const q = db
      .selectFrom("users")
      .where(({ name }) => name.like("%ob%"))
      .compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].name).toBe("Bob")
  })

  it("WHERE IS NULL", async () => {
    const q = db
      .selectFrom("users")
      .where(({ meta }) => meta.isNull())
      .compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].name).toBe("Charlie")
  })

  it("ORDER BY + LIMIT", async () => {
    const q = db.selectFrom("users").orderBy("age", "DESC").limit(2).compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(2)
    expect(r.rows[0].name).toBe("Charlie")
  })

  it("COUNT(*) aggregate", async () => {
    const q = db.selectFrom("users").select({ total: count() }).compile(printer)
    const r = await run(q)
    // MySQL returns COUNT as a numeric/bigint depending on driver
    // settings — coerce before asserting.
    expect(Number(r.rows[0].total)).toBe(3)
  })

  it("INNER JOIN", async () => {
    const q = db
      .selectFrom("users")
      .innerJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))
      .select("name", "title")
      .compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(3)
  })
})

describe.skipIf(!enabled)("MySQL integration — mutations", () => {
  it("INSERT", async () => {
    const q = db
      .insertInto("users")
      .values({ name: "Dave", email: "dave@example.com", age: 40, active: true, meta: null })
      .compile(printer)
    await run(q)
    const check = await run(
      db
        .selectFrom("users")
        .where(({ name }) => name.eq("Dave"))
        .compile(printer),
    )
    expect(check.rows.length).toBe(1)
    expect(Number(check.rows[0].age)).toBe(40)
  })

  it("UPDATE with WHERE", async () => {
    const q = db
      .update("users")
      .set({ age: 41 })
      .where(({ name }) => name.eq("Dave"))
      .compile(printer)
    await run(q)
    const check = await run(
      db
        .selectFrom("users")
        .where(({ name }) => name.eq("Dave"))
        .compile(printer),
    )
    expect(Number(check.rows[0].age)).toBe(41)
  })

  it("DELETE with WHERE", async () => {
    const q = db
      .deleteFrom("users")
      .where(({ name }) => name.eq("Dave"))
      .compile(printer)
    await run(q)
    const check = await run(
      db
        .selectFrom("users")
        .where(({ name }) => name.eq("Dave"))
        .compile(printer),
    )
    expect(check.rows.length).toBe(0)
  })

  it("INSERT respects the WHERE-guard's predicate type", async () => {
    // Regression for the silent `.where()` bug (PR #95). MySQL must
    // see the WHERE clause carry through with bound parameters —
    // otherwise a row-scoped DELETE would wipe the whole table.
    const q = db
      .deleteFrom("posts")
      .where(({ id }) => id.eq(999))
      .compile(printer)
    expect(q.params.length).toBeGreaterThan(0)
    expect(q.sql.toUpperCase()).toContain("WHERE")
  })
})

describe.skipIf(!enabled)("MySQL integration — boolean literals", () => {
  it("active = TRUE matches rows correctly", async () => {
    // MySQL doesn't have a real BOOLEAN — it's TINYINT(1). The dialect
    // printer is responsible for emitting the value side as `1`/`0`
    // so the comparison succeeds. This pins that behavior.
    const q = db
      .selectFrom("users")
      .where(({ active }) => active.eq(true))
      .compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(2)
    expect(r.rows.every((row) => Number(row.active) === 1)).toBe(true)
  })

  it("filter with val() boolean", async () => {
    const q = db
      .selectFrom("users")
      .where(({ active }) => active.eq(val(false)))
      .compile(printer)
    const r = await run(q)
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].name).toBe("Charlie")
  })
})
