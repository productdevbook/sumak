import { PGlite } from "@electric-sql/pglite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { and, case_, cast, count, exists, not, or, val } from "../../src/builder/eb.ts"
import { select } from "../../src/builder/select.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import { boolean, integer, jsonb, serial, text, timestamp } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer().nullable(),
      active: boolean().defaultTo(true),
      meta: jsonb(),
      createdAt: timestamp().defaultTo("now()"),
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

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()

  await pg.exec(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      age INTEGER,
      active BOOLEAN DEFAULT true,
      meta JSONB,
      "createdAt" TIMESTAMP DEFAULT now()
    );

    CREATE TABLE posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      "userId" INTEGER REFERENCES users(id)
    );

    INSERT INTO users (name, email, age, active, meta) VALUES
      ('Alice', 'alice@example.com', 30, true, '{"role": "admin"}'),
      ('Bob', 'bob@example.com', 25, true, '{"role": "user"}'),
      ('Charlie', 'charlie@example.com', 35, false, null);

    INSERT INTO posts (title, body, "userId") VALUES
      ('Hello World', 'First post', 1),
      ('Second Post', 'Another one', 1),
      ('Bob Post', 'From Bob', 2);
  `)
})

afterAll(async () => {
  await pg.close()
})

async function run(query: { sql: string; params: readonly unknown[] }) {
  return pg.query<Record<string, any>>(query.sql, query.params as any[])
}

describe("PGlite Integration — SELECT", () => {
  it("SELECT all users", async () => {
    const q = db.selectFrom("users").compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(3)
  })

  it("SELECT specific columns", async () => {
    const q = db.selectFrom("users").select("id", "name").compile(printer)
    const result = await run(q)
    expect(result.rows[0]).toHaveProperty("id")
    expect(result.rows[0]).toHaveProperty("name")
    expect(result.rows[0]).not.toHaveProperty("email")
  })

  it("WHERE eq", async () => {
    const q = db
      .selectFrom("users")
      .where(({ id }) => id.eq(1))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].name).toBe("Alice")
  })

  it("WHERE gt", async () => {
    const q = db
      .selectFrom("users")
      .where(({ age }) => age.gt(28))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(2)
  })

  it("WHERE LIKE", async () => {
    const q = db
      .selectFrom("users")
      .where(({ name }) => name.like("%ob%"))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].name).toBe("Bob")
  })

  it("WHERE IN", async () => {
    const q = db
      .selectFrom("users")
      .where(({ id }) => id.in([1, 3]))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(2)
  })

  it("WHERE IS NULL", async () => {
    const q = db
      .selectFrom("users")
      .where(({ meta }) => meta.isNull())
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].name).toBe("Charlie")
  })

  it("WHERE BETWEEN", async () => {
    const q = db
      .selectFrom("users")
      .where(({ age }) => age.between(25, 30))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(2)
  })

  it("WHERE AND", async () => {
    const q = db
      .selectFrom("users")
      .where(({ active, age }) => and(active.eq(true), age.gt(28)))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].name).toBe("Alice")
  })

  it("WHERE OR", async () => {
    const q = db
      .selectFrom("users")
      .where(({ name }) => or(name.eq("Alice"), name.eq("Bob")))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(2)
  })

  it("WHERE NOT", async () => {
    const q = db
      .selectFrom("users")
      .where(({ active }) => not(active.eq(true)))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].name).toBe("Charlie")
  })

  it("ORDER BY + LIMIT + OFFSET", async () => {
    const q = db.selectFrom("users").orderBy("name").limit(2).offset(1).compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(2)
    expect(result.rows[0].name).toBe("Bob")
  })

  it("DISTINCT", async () => {
    const q = db.selectFrom("users").select("active").distinct().compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(2)
  })

  it("GROUP BY + COUNT", async () => {
    const q = db
      .selectFrom("users")
      .select("active")
      .select({ cnt: count() })
      .groupBy("active")
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(2)
  })
})

describe("PGlite Integration — JOIN", () => {
  it("INNER JOIN", async () => {
    const q = db
      .selectFrom("users")
      .innerJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))
      .select("name", "title")
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(3)
  })

  it("LEFT JOIN", async () => {
    const q = db
      .selectFrom("users")
      .leftJoin("posts", ({ users, posts }) => users.id.eq(posts.userId))
      .select("name", "title")
      .compile(printer)
    const result = await run(q)
    // Charlie has no posts → null title
    expect(result.rows.length).toBe(4)
  })
})

describe("PGlite Integration — INSERT", () => {
  it("INSERT + RETURNING", async () => {
    const q = db
      .insertInto("users")
      .values({ name: "Diana", email: "diana@example.com" })
      .returningAll()
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].name).toBe("Diana")
    expect(result.rows[0].id).toBeDefined()
  })

  it("INSERT + ON CONFLICT DO NOTHING", async () => {
    // Need a unique constraint for this — use a raw query for setup
    await pg.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
    const q = db
      .insertInto("users")
      .values({ name: "Alice", email: "alice@example.com" })
      .onConflictDoNothing("email")
      .compile(printer)
    // Should not throw
    const result = await run(q)
    expect(result.rows.length).toBe(0)
  })
})

describe("PGlite Integration — UPDATE", () => {
  it("UPDATE + WHERE + RETURNING", async () => {
    const q = db
      .update("users")
      .set({ active: false })
      .where(({ name }) => name.eq("Bob"))
      .returning("id", "active")
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].active).toBe(false)
  })
})

describe("PGlite Integration — DELETE", () => {
  it("DELETE + WHERE + RETURNING", async () => {
    const q = db
      .deleteFrom("users")
      .where(({ name }) => name.eq("Diana"))
      .returning("id")
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
  })
})

describe("PGlite Integration — Advanced Expressions", () => {
  it("CASE expression", async () => {
    const q = db
      .selectFrom("users")
      .select({
        answer: case_()
          .when(val(true) as any, val("yes"))
          .else_(val("no"))
          .end(),
      })
      .compile(printer)
    const result = await run(q)
    expect(result.rows[0].answer).toBe("yes")
  })

  it("CAST", async () => {
    const q = db
      .selectFrom("users")
      .select({ num: cast(val(42), "text") })
      .limit(1)
      .compile(printer)
    const result = await run(q)
    expect(result.rows[0].num).toBe("42")
  })

  it("EXISTS subquery", async () => {
    const sub = select("id")
      .from("posts")
      .where({
        type: "binary_op",
        op: "=",
        left: { type: "column_ref", column: "userId" },
        right: { type: "literal", value: 1 },
      })
      .build()
    const q = db
      .selectFrom("users")
      .where(() => exists(sub))
      .compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBeGreaterThan(0)
  })

  it("CTE (WITH)", async () => {
    const cte = db
      .selectFrom("users")
      .where(({ active }) => active.eq(true))
      .build()
    const q = db.selectFrom("users").with("active_users", cte).compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBeGreaterThan(0)
  })
})

describe("PGlite Integration — Set Operations", () => {
  it("UNION", async () => {
    const q1 = db
      .selectFrom("users")
      .select("name")
      .where(({ id }) => id.eq(1))
    const q2 = db
      .selectFrom("users")
      .select("name")
      .where(({ id }) => id.eq(2))
    const q = q1.union(q2).compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(2)
  })

  it("INTERSECT", async () => {
    const q1 = db.selectFrom("users").select("name")
    const q2 = db
      .selectFrom("users")
      .select("name")
      .where(({ id }) => id.eq(1))
    const q = q1.intersect(q2).compile(printer)
    const result = await run(q)
    expect(result.rows.length).toBe(1)
  })
})
