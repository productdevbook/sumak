import { describe, expectTypeOf, it } from "vitest"

import { boolean, integer, serial, text } from "../../src/schema/column.ts"
import type {
  InferInsertModel,
  InferSelectModel,
  InferUpdateModel,
  Insertable,
  Selectable,
  Updateable,
} from "../../src/schema/index.ts"

// Drizzle-style row-type helpers.
//
// These are aliases for the existing `Selectable<T>` /
// `Insertable<T>` / `Updateable<T>` helpers — the same types under
// drizzle-compatible names so users coming from drizzle find the
// API they expect. The tests below pin that the aliases really are
// equivalent (not subtly divergent re-implementations) and that
// they infer the right row shape for typical column maps.

const userColumns = {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  active: boolean().defaultTo(true),
  ageHint: integer().nullable(),
}

describe("InferSelectModel<T>", () => {
  it("equals Selectable<T>", () => {
    type Drizzle = InferSelectModel<typeof userColumns>
    type Sumak = Selectable<typeof userColumns>
    expectTypeOf<Drizzle>().toEqualTypeOf<Sumak>()
  })

  it("produces a row type with every column required and non-nullable for not-null cols", () => {
    type Row = InferSelectModel<typeof userColumns>
    // SELECT returns every column. Even columns the schema says are
    // nullable come back as `T | null`, never `T | undefined`. (UI
    // queries that lift undefined from the row would silently break
    // if the inferred type used optional keys instead.)
    expectTypeOf<Row>().toMatchTypeOf<{
      id: number
      name: string
      email: string
      active: boolean
      ageHint: number | null
    }>()
  })
})

describe("InferInsertModel<T>", () => {
  it("equals Insertable<T>", () => {
    type Drizzle = InferInsertModel<typeof userColumns>
    type Sumak = Insertable<typeof userColumns>
    expectTypeOf<Drizzle>().toEqualTypeOf<Sumak>()
  })

  it("makes generated / default / nullable columns optional", () => {
    type Row = InferInsertModel<typeof userColumns>
    // `id` (serial) is generated, `active` has a default, `ageHint`
    // is nullable — all three should be optional on insert.
    expectTypeOf<Row>().toMatchTypeOf<{
      id?: number
      name: string
      email: string
      active?: boolean | undefined
      ageHint?: number | null
    }>()
  })
})

describe("InferUpdateModel<T>", () => {
  it("equals Updateable<T>", () => {
    type Drizzle = InferUpdateModel<typeof userColumns>
    type Sumak = Updateable<typeof userColumns>
    expectTypeOf<Drizzle>().toEqualTypeOf<Sumak>()
  })

  it("makes every column optional", () => {
    type Row = InferUpdateModel<typeof userColumns>
    // UPDATE is always a partial — only the columns the caller
    // listed change. Drizzle picked this shape; sumak matches.
    expectTypeOf<Row>().toMatchTypeOf<{
      id?: number
      name?: string
      email?: string
      active?: boolean
      ageHint?: number | null
    }>()
  })
})
