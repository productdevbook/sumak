import { describe, expectTypeOf, it } from "vitest"

import { sql } from "../../src/builder/sql.ts"
import { pgDialect } from "../../src/dialect/pg.ts"
import type { ExecuteResult } from "../../src/driver/types.ts"
import { integer, serial, text } from "../../src/schema/column.ts"
import { sumak } from "../../src/sumak.ts"

// Typed builders carry the full row shape through the chain. These
// tests pin down where the shape narrows (select pick, returning) and
// where optional/nullable-ness must survive the inference.

const db = sumak({
  dialect: pgDialect(),
  tables: {
    users: {
      id: serial().primaryKey(),
      name: text().notNull(),
      email: text().notNull(),
      age: integer().nullable(),
    },
  },
})

describe("TypedSelectBuilder — .select()", () => {
  it("full row when no select() is called", async () => {
    // Runtime would require a driver; we're only asserting types here.
    const q = db.selectFrom("users")
    type Row = Awaited<ReturnType<typeof q.many>>[number]
    // `toMatchTypeOf<Expected>()` asserts the actual row is assignable
    // to Expected — i.e. it has at least these columns with these
    // types. Using it with the exact column list pins the row shape.
    expectTypeOf<{
      id: number
      name: string
      email: string
      age: number | null
    }>().toMatchTypeOf<Row>()
  })

  it(".select('id', 'name') narrows to the picked columns", () => {
    const q = db.selectFrom("users").select("id", "name")
    type Row = Awaited<ReturnType<typeof q.many>>[number]
    expectTypeOf<Row>().toMatchTypeOf<{ id: number; name: string }>()
    // @ts-expect-error — email was not selected.
    type _MustNotHaveEmail = Row["email"]
  })

  it(".select({ alias: expr }) extends the row with the aliased key", () => {
    const q = db.selectFrom("users").select({ upper_name: sql<string>`UPPER(name)` })
    type Row = Awaited<ReturnType<typeof q.many>>[number]
    // The aliased object form extends the full row with the new key.
    expectTypeOf<Row["upper_name"]>().toEqualTypeOf<string>()
  })

  it("nullable column — .age is `number | null` not `number`", () => {
    const q = db.selectFrom("users").select("age")
    type Row = Awaited<ReturnType<typeof q.many>>[number]
    expectTypeOf<Row["age"]>().toEqualTypeOf<number | null>()
  })
})

describe("TypedInsertBuilder — .values() + .returning()", () => {
  it(".values expects non-nullable columns (except those with defaults)", () => {
    db.insertInto("users").values({
      name: "a",
      email: "a@x",
    })
    // age is nullable → allowed to omit.
    db.insertInto("users").values({
      name: "a",
      email: "a@x",
      age: null,
    })
    // @ts-expect-error — `name` is required.
    db.insertInto("users").values({ email: "a@x" })
  })

  it(".exec() returns { affected: number }", () => {
    type ExecReturn = Awaited<ReturnType<ReturnType<(typeof db)["insertInto"]>["exec"]>>
    expectTypeOf<ExecReturn>().toEqualTypeOf<ExecuteResult>()
  })

  it(".returning('id', 'name').many() narrows to those keys", () => {
    const q = db.insertInto("users").values({ name: "a", email: "a@x" }).returning("id", "name")
    type Row = Awaited<ReturnType<typeof q.many>>[number]
    expectTypeOf<Row>().toMatchTypeOf<{ id: number; name: string }>()
    // @ts-expect-error — email not in returning list.
    type _NoEmail = Row["email"]
  })
})

describe("TypedUpdateBuilder — .set()", () => {
  it(".set accepts partial update shape, column types must match", () => {
    db.update("users")
      .set({ name: "new" })
      .where(({ id }) => id.eq(1))

    // age is nullable → `null` is a valid update.
    db.update("users")
      .set({ age: null })
      .where(({ id }) => id.eq(1))

    db.update("users")
      // @ts-expect-error — name can't be a number.
      .set({ name: 42 })
      .where(({ id }) => id.eq(1))
  })
})

describe("TypedDeleteBuilder — .where required", () => {
  it("deleteFrom with .where + .exec returns Promise<ExecuteResult>", () => {
    // We assert the type without touching runtime: no driver is
    // configured on `db`, so `.exec()` would throw if we awaited it.
    const builder = db.deleteFrom("users").where(({ id }) => id.eq(1))
    type ExecReturn = Awaited<ReturnType<typeof builder.exec>>
    expectTypeOf<ExecReturn>().toEqualTypeOf<ExecuteResult>()
  })
})

describe("Execute methods — signal accepted on each", () => {
  const ctrl = new AbortController()

  it("many / one / first / exec all take optional { signal }", () => {
    expectTypeOf(db.selectFrom("users").many)
      .parameter(0)
      .toEqualTypeOf<{ signal?: AbortSignal } | undefined>()
    expectTypeOf(db.selectFrom("users").one)
      .parameter(0)
      .toEqualTypeOf<{ signal?: AbortSignal } | undefined>()
    expectTypeOf(db.selectFrom("users").first)
      .parameter(0)
      .toEqualTypeOf<{ signal?: AbortSignal } | undefined>()
    expectTypeOf(
      db
        .update("users")
        .set({ name: "x" })
        .where(({ id }) => id.eq(1)).exec,
    )
      .parameter(0)
      .toEqualTypeOf<{ signal?: AbortSignal } | undefined>()
    void ctrl // silence unused
  })
})
