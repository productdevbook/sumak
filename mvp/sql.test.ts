import { describe, expect, it } from "vitest"

import { int, t, text, ts } from "./index.ts"
import { make } from "./sql.ts"

const schema = {
  users: { id: int(), name: text(), email: text(), createdAt: ts() },
  posts: { id: int(), authorId: int(), title: text(), body: text(), published: int() },
}

const q = make(schema)

describe("the query is already a string", () => {
  it("keeps the text and counts the parameters", () => {
    const findUser = q("SELECT id, name FROM users WHERE id = $1", t.num)
    expect(findUser.sql).toBe("SELECT id, name FROM users WHERE id = $1")
    expect(findUser.arity).toBe(1)
    expect(findUser.direct).toBe(true)
  })

  it("binds by handing the caller's own array straight through", () => {
    const find = q("SELECT * FROM users WHERE name = $1 AND id > $2", t.text, t.num)
    const args: [string, number] = ["ada", 3]
    expect(find.bind(args)).toBe(args)
  })

  it("types the arguments from the declared kinds", () => {
    const find = q("SELECT id FROM users WHERE name = $1 AND id > $2", t.text, t.num)
    const args: Parameters<typeof find.bind>[0] = ["ada", 3]
    const back: readonly [string, number] = args
    expect(back).toEqual(["ada", 3])
  })

  it("reads the row type out of the schema", () => {
    const one = q("SELECT id, name FROM users WHERE id = $1", t.num)
    const oneRow: NonNullable<typeof one.__row> = { id: 1, name: "ada" }
    const oneBack: { id: number; name: string } = oneRow
    expect(oneBack.name).toBe("ada")

    const all = q("SELECT * FROM posts")
    const allRow: NonNullable<typeof all.__row> = {
      id: 1,
      authorId: 2,
      title: "t",
      body: "b",
      published: 1,
    }
    const allBack: {
      id: number
      authorId: number
      title: string
      body: string
      published: number
    } = allRow
    expect(allBack.title).toBe("t")
  })

  it("follows an alias to the name the row will carry", () => {
    const aliased = q("SELECT name AS label FROM users")
    const row: NonNullable<typeof aliased.__row> = { label: "x" }
    const back: { label: string } = row
    expect(back.label).toBe("x")
  })

  it("widens rather than lying when the query is past what it can read", () => {
    const joined = q("SELECT p.title FROM posts p INNER JOIN users u ON p.authorId = u.id")
    const row: NonNullable<typeof joined.__row> = { title: "anything" }
    const back: { title: unknown } = row
    expect(back.title).toBe("anything")
  })

  it("refuses a placeholder that was never declared", () => {
    expect(() => q("SELECT * FROM users WHERE id = $2", t.num)).toThrow(/uses \$2/)
  })

  it("refuses a declared parameter the query never uses", () => {
    expect(() => q("SELECT * FROM users WHERE id = $1", t.num, t.text)).toThrow(
      /\$2 was declared but never used/,
    )
  })
})
