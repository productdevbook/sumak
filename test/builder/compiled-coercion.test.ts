import { describe, expect, it } from "vitest"

import { pgDialect } from "../../src/dialect/pg.ts"
import { placeholder, sumak } from "../../src/index.ts"
import { integer, serial, text } from "../../src/schema/column.ts"

// A compiled query fills its placeholders without printing anything, so the
// conversion the printer does on the way past never ran for those values. A
// `bigint` reaching `pg` or `mysql2` unconverted is rejected by the driver, so
// the two paths have to agree on what they hand over.

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: { id: serial().primaryKey(), name: text().notNull(), balance: integer().notNull() },
  },
})

describe("a compiled query converts its parameters like the printer does", () => {
  it("turns a bigint into its decimal string", () => {
    const compiled = db
      .selectFrom("users")
      .select("id")
      .where(({ id }) => id.eq(placeholder("id") as never))
      .toCompiled<{ id: bigint }>()

    const out = compiled({ id: 9007199254740993n })
    expect(out.params).toEqual(["9007199254740993"])
    expect(out.params.every((p) => typeof p !== "bigint")).toBe(true)
  })

  it("agrees with the uncompiled path", () => {
    const value = 9007199254740993n

    const compiled = db
      .selectFrom("users")
      .select("id")
      .where(({ id }) => id.eq(placeholder("id") as never))
      .toCompiled<{ id: bigint }>()({ id: value })

    const direct = db
      .selectFrom("users")
      .select("id")
      .where(({ id }) => id.eq(value as never))
      .toSQL()

    expect(compiled.sql).toBe(direct.sql)
    expect(compiled.params).toEqual(direct.params)
  })

  it("leaves other values alone", () => {
    const compiled = db
      .selectFrom("users")
      .select("id")
      .where(({ name }) => name.eq(placeholder("name") as never))
      .toCompiled<{ name: string }>()

    expect(compiled({ name: "ada" }).params).toEqual(["ada"])
  })
})
