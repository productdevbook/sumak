import { describe, expect, expectTypeOf, it } from "vitest"

import { and, db, int, lit, mysql, or, t, text, ts } from "./index.ts"

const schema = {
  users: { id: int(), name: text(), email: text(), createdAt: ts() },
  posts: { id: int(), authorId: int(), title: text(), body: text(), published: int() },
}

const d = db(schema)

describe("definition", () => {
  it("compiles once and binds by handing the array straight through", () => {
    const findUser = d
      .from("users")
      .params(t.num)
      .pick("id", "name")
      .where((c, [id]) => c.users.id.eq(id))
      .build()

    expect(findUser.sql).toBe(
      'SELECT "users"."id", "users"."name" FROM "users" WHERE ("users"."id" = $1)',
    )
    const args: [number] = [42]
    expect(findUser.bind(args)).toBe(args)
    expect(findUser.direct).toBe(true)
  })

  it("types the arguments and the row", () => {
    const q = d
      .from("users")
      .params(t.num, t.text)
      .pick("id", "name")
      .where((c, [id, name]) => and(c.users.id.eq(id), c.users.name.eq(name)))
      .build()

    expectTypeOf<Parameters<typeof q.bind>[0]>().toEqualTypeOf<[number, string]>()
    expectTypeOf<NonNullable<typeof q.__row>>().toEqualTypeOf<{ id: number; name: string }>()
  })

  it("numbers placeholders by argument, so nothing is reordered at call time", () => {
    const q = d
      .from("users")
      .params(t.num, t.num)
      .where((c, [, id]) => c.users.id.eq(id))
      .limit(([n]) => n)
      .build()

    expect(q.sql).toBe('SELECT * FROM "users" WHERE ("users"."id" = $2) LIMIT $1')
  })

  it("joins and widens the scope", () => {
    const q = d
      .from("posts")
      .pick("id", "title")
      .join("users", (c) => c.posts.authorId.eq(c.users.id))
      .build()

    expect(q.sql).toBe(
      'SELECT "posts"."id", "posts"."title" FROM "posts" INNER JOIN "users" ON ("posts"."authorId" = "users"."id")',
    )
  })

  it("writes, updates and deletes", () => {
    const add = d
      .insertInto("users")
      .params(t.num, t.text)
      .values(([id, name]) => [{ id, name }])
      .returning("id")
      .build()
    expect(add.sql).toBe('INSERT INTO "users" ("id", "name") VALUES ($1, $2) RETURNING "id"')

    const rename = d
      .update("users")
      .params(t.text, t.num)
      .set(([name]) => ({ name }))
      .where((c, [, id]) => c.users.id.eq(id))
      .build()
    expect(rename.sql).toBe('UPDATE "users" SET "name" = $1 WHERE ("users"."id" = $2)')

    const remove = d
      .deleteFrom("users")
      .params(t.num)
      .where((c, [id]) => c.users.id.eq(id))
      .build()
    expect(remove.sql).toBe('DELETE FROM "users" WHERE ("users"."id" = $1)')
  })

  it("carries the dialect", () => {
    const q = db(schema, mysql)
      .from("users")
      .params(t.num)
      .where((c, [id]) => c.users.id.eq(id))
      .build()
    expect(q.sql).toBe("SELECT * FROM `users` WHERE (`users`.`id` = ?)")
    expect(q.direct).toBe(false)
  })

  it("refuses a declared parameter the query never uses", () => {
    expect(() => d.from("users").params(t.num, t.num).build()).toThrow(/declared but never used/)
  })
})

describe("what the types refuse", () => {
  it("a statement has only the clauses that belong to it", () => {
    const insert = d.insertInto("users")
    expectTypeOf(insert).not.toHaveProperty("groupBy")
    expectTypeOf(insert).not.toHaveProperty("orderBy")
    expectTypeOf(insert).not.toHaveProperty("distinct")
    expectTypeOf(d.deleteFrom("users")).not.toHaveProperty("pick")
  })

  it("a column outside the schema cannot be written", () => {
    // @ts-expect-error nosuchcolumn is not a column of users
    d.insertInto("users").values(() => [{ nosuchcolumn: lit(1) }])
  })

  it("a bare value cannot reach a predicate", () => {
    // @ts-expect-error a value must be a parameter or an explicit lit()
    d.from("users").where((c) => c.users.name.eq("ada"))
  })

  it("a value of the wrong type cannot reach a predicate", () => {
    // @ts-expect-error name is text, not a number
    d.from("users").where((c) => c.users.name.eq(lit(1)))
  })
})

describe("what the split makes impossible", () => {
  it("two IN lists on one column both survive", () => {
    const q = d
      .from("users")
      .params(t.num, t.num, t.num, t.num)
      .where((c, [a, b, x, y]) => and(c.users.id.in([a, b]), c.users.id.in([x, y])))
      .build()

    expect(q.sql).toBe(
      'SELECT * FROM "users" WHERE ("users"."id" IN ($1, $2) AND "users"."id" IN ($3, $4))',
    )
  })

  it("equal values cannot collapse a predicate, because the text is already fixed", () => {
    const q = d
      .from("users")
      .params(t.num, t.num)
      .where((c, [a, b]) => or(c.users.id.eq(a), c.users.id.eq(b)))
      .build()

    expect(q.sql).toContain("$1")
    expect(q.sql).toContain("$2")
    expect(q.bind([1, 1])).toEqual([1, 1])
  })
})
