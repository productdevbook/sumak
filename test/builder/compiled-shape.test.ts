import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { placeholder, sumak } from "../../src/index.ts"
import { integer, serial, text } from "../../src/schema/column.ts"

// A compiled query exists so that a request does nothing but fill parameters.
// These pin the properties that make that true; the timing itself belongs in
// `bench/`, because a number measured under a test runner is noise.

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: { id: serial().primaryKey(), name: text().notNull(), age: integer().notNull() },
  },
})

const findUser = db
  .selectFrom("users")
  .select("id", "name")
  .where(({ id }) => id.eq(placeholder("id") as never))
  .toCompiled<{ id: number }>()

describe("a compiled query is compiled once", () => {
  it("holds one SQL string, whatever the values are", () => {
    expect(findUser({ id: 1 }).sql).toBe(findUser.sql)
    expect(findUser({ id: 99 }).sql).toBe(findUser.sql)
    expect(findUser.sql).toBe('SELECT "id", "name" FROM "users" WHERE ("id" = $1)')
  })

  it("returns a fresh parameter array each call, so callers cannot alias", () => {
    const first = findUser({ id: 1 })
    const second = findUser({ id: 2 })

    expect(first.params).not.toBe(second.params)
    expect(first.params).toEqual([1])
    expect(second.params).toEqual([2])
  })

  it("does not consult the pipeline again", () => {
    let compiles = 0
    const counted = sumak({
      dialect: pgDialect(),
      tables: { users: { id: serial().primaryKey(), name: text().notNull() } },
      plugins: [
        {
          name: "count-compiles",
          transformNode(node) {
            compiles++
            return node
          },
        },
      ],
    })

    const query = counted
      .selectFrom("users")
      .select("id")
      .where(({ id }) => id.eq(placeholder("id") as never))
      .toCompiled<{ id: number }>()

    const afterCompile = compiles
    for (let i = 0; i < 25; i++) query({ id: i })

    expect(afterCompile).toBeGreaterThan(0)
    expect(compiles).toBe(afterCompile)
  })

  it("fills every arity the specialised shapes cover, and past them", () => {
    const shapes = [0, 1, 2, 3, 4, 5] as const
    for (const arity of shapes) {
      const names = Array.from({ length: arity }, (_, i) => `p${i}`)
      let builder = db.selectFrom("users").selectAll()
      for (const name of names) {
        builder = builder.where(({ age }) => age.gt(placeholder(name) as never))
      }
      const compiled = builder.toCompiled<Record<string, number>>()
      const params: Record<string, number> = {}
      names.forEach((name, i) => {
        params[name] = i + 1
      })

      expect(compiled(params).params).toEqual(names.map((_, i) => i + 1))
    }
  })
})
